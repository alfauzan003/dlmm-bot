import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { WSOL_MINT } from "../core/constants.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { getTokenBalance } from "../solana/balances.js";
import { buildFeePlan, checkFeeCap } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getDlmmSdk } from "./sdk.js";

function withDeps(deps = {}) {
  return {
    getConnection,
    getWallet,
    getDlmmSdk,
    getTokenBalance,
    buildFeePlan,
    checkFeeCap,
    sendAndConfirmRobust,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...deps,
  };
}

// `poolAddress` (opsional): pool pemilik posisi; tanpa itu pool dicari lewat scan semua posisi wallet.
export async function closePosition(positionAddress, { poolAddress: knownPool = null, deps } = {}) {
  const d = withDeps(deps);
  const connection = d.getConnection();
  const wallet = d.getWallet();
  const { DLMM } = await d.getDlmmSdk();

  if (!positionAddress) {
    return { success: false, error: "no position address" };
  }

  if (config.dryRun) {
    log.info(`[DRY RUN] Would close position ${positionAddress.slice(0, 8)}`);
    return { success: true, dryRun: true };
  }

  const positionPubKey = new PublicKey(positionAddress);

  // Close (TP/SL/Trail) tidak pernah dibatalkan karena cap biaya: hanya diperingatkan.
  const feeCap = d.checkFeeCap(d.buildFeePlan());
  if (!feeCap.ok) {
    log.warn(
      `Close ${positionAddress.slice(0, 8)}: fee estimate ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL — tetap dikirim`
    );
  }
  // Rencana fee baru per tx (tip Jito hanya dipasang sekali per objek rencana). Tx SDK sudah membawa
  // setComputeUnitLimit sendiri, jadi limit dari config tidak ditambahkan (hindari instruksi ganda).
  const txFeePlan = () => ({ ...d.buildFeePlan(), computeUnitLimit: 0 });
  const send = async (tx) =>
    (await d.sendAndConfirmRobust({ connection, tx, signers: [wallet], feePlan: txFeePlan(), wallet })).signature;

  try {
    // Find the pool that owns this position (scan semua posisi wallet hanya bila pool belum diketahui)
    let poolAddress = knownPool;
    let pool = null;

    if (!poolAddress) {
      const allPositions = await DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey);
      for (const [lbPairKey, info] of allPositions) {
        const posList = info?.lbPairPositionsData || [];
        const match = posList.find((p) => p.publicKey.toString() === positionAddress);
        if (match) {
          poolAddress = lbPairKey;
          break;
        }
      }
    }

    if (!poolAddress) {
      return { success: false, error: "position not found in any pool" };
    }

    pool = await DLMM.create(connection, new PublicKey(poolAddress));

    // Close position
    let closeFromBin, closeToBin;
    let hasLiquidity = false;

    try {
      const positionData = await pool.getPosition(positionPubKey);
      const processed = positionData?.positionData;
      if (processed) {
        closeFromBin = processed.lowerBinId;
        closeToBin = processed.upperBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((b) => new BN(b.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (err) {
      log.warn(`Could not check liquidity: ${err.message}`);
    }

    // Claim fee terpisah hanya untuk posisi tanpa likuiditas: removeLiquidity dengan
    // shouldClaimAndClose sudah memuat claim fee + reward dalam tx close.
    let claimTx = null;
    if (!hasLiquidity) {
      try {
        const { userPositions } = await pool.getPositionsByUserAndLbPair(wallet.publicKey);
        const userPos = userPositions?.find((p) => p.publicKey.toString() === positionAddress);
        if (userPos) {
          const claimTxs = await pool.claimSwapFee({ owner: wallet.publicKey, position: userPos });
          const txs = Array.isArray(claimTxs) ? claimTxs : [claimTxs];
          for (const tx of txs) {
            claimTx = await send(tx);
          }
          if (claimTx) log.info(`Claimed fees: ${claimTx.slice(0, 16)}`);
        }
      } catch (err) {
        log.warn(`Fee claim skipped: ${err.message}`);
      }
    }

    const closeTxHashes = [];
    const maxAttempts = 3;

    const sendCloseTx = async () => {
      closeTxHashes.length = 0;
      if (hasLiquidity) {
        const closeTx = await pool.removeLiquidity({
          user: wallet.publicKey,
          position: positionPubKey,
          fromBinId: closeFromBin,
          toBinId: closeToBin,
          bps: new BN(10000),
          shouldClaimAndClose: true,
        });

        const txs = Array.isArray(closeTx) ? closeTx : [closeTx];
        for (const tx of txs) {
          const hash = await send(tx);
          closeTxHashes.push(hash);
        }
      } else {
        const closeTx = await pool.closePosition({
          owner: wallet.publicKey,
          position: { publicKey: positionPubKey },
        });
        const hash = await send(closeTx);
        closeTxHashes.push(hash);
      }
    };

    // Retry dengan rebuild tx: state bin bisa berubah antar percobaan.
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await sendCloseTx();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const brief = String(err.message || err).split("\n")[0];
        log.warn(`Close attempt ${attempt}/${maxAttempts} failed for ${positionAddress.slice(0, 8)}: ${brief}`);
        if (attempt < maxAttempts) await d.sleep(2000);
      }
    }
    if (lastErr) throw lastErr;

    // Verify position is actually closed: akun posisi dihapus saat close (tx sudah confirmed).
    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const account = await connection.getAccountInfo(positionPubKey);
        if (!account) {
          closedConfirmed = true;
          break;
        }
        log.warn(`Position ${positionAddress.slice(0, 8)} still appears open (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log.warn(`Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await d.sleep(3000);
    }

    if (!closedConfirmed) {
      log.warn(`Position ${positionAddress.slice(0, 8)} may still be open after close — continuing anyway`);
    }

    let baseMint = null;
    let baseAmount = 0;
    if (pool.lbPair) {
      const xMint = pool.lbPair.tokenXMint?.toString() || "";
      const yMint = pool.lbPair.tokenYMint?.toString() || "";
      const nonSolMint = xMint === WSOL_MINT ? yMint : xMint;
      if (nonSolMint && nonSolMint !== WSOL_MINT) {
        baseMint = nonSolMint;
        baseAmount = await d.getTokenBalance(nonSolMint);
      }
    }

    log.info(`Closed ${positionAddress.slice(0, 8)}: ${closeTxHashes[0]?.slice(0, 16) || "no tx"}`);

    return {
      success: true,
      position: positionAddress,
      pool: poolAddress,
      claimTx,
      txs: closeTxHashes,
      baseMint,
      baseAmount,
    };
  } catch (err) {
    log.error(`closePosition failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
