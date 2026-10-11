import { PublicKey } from "@solana/web3.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { buildFeePlan } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getDlmmSdk } from "./sdk.js";

// Klaim fee swap satu posisi (posisi tetap terbuka). Pool dicari sama seperti closePosition.
export async function claimPositionFees(positionAddress) {
  if (!positionAddress) return { success: false, error: "no position address", txs: [] };

  if (config.dryRun) {
    log.info(`[DRY RUN] Would claim fees for position ${positionAddress.slice(0, 8)}`);
    return { success: true, dryRun: true, txs: [] };
  }

  try {
    const connection = getConnection();
    const wallet = getWallet();
    const { DLMM } = await getDlmmSdk();

    const allPositions = await DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey);
    let poolAddress = null;
    for (const [lbPairKey, info] of allPositions) {
      const posList = info?.lbPairPositionsData || [];
      if (posList.some((p) => p.publicKey.toString() === positionAddress)) {
        poolAddress = lbPairKey;
        break;
      }
    }
    if (!poolAddress) return { success: false, error: "position not found in any pool", txs: [] };

    const pool = await DLMM.create(connection, new PublicKey(poolAddress));
    const { userPositions } = await pool.getPositionsByUserAndLbPair(wallet.publicKey);
    const userPos = userPositions?.find((p) => p.publicKey.toString() === positionAddress);
    if (!userPos) return { success: false, error: "position not found for wallet", txs: [] };

    const claimTxs = await pool.claimSwapFee({ owner: wallet.publicKey, position: userPos });
    const list = Array.isArray(claimTxs) ? claimTxs : [claimTxs];
    const txs = [];
    for (const tx of list) {
      // Fee plan baru per tx: sendAndConfirmRobust mengisi tip Jito ke plan.
      const res = await sendAndConfirmRobust({
        connection,
        tx,
        signers: [wallet],
        feePlan: buildFeePlan(),
        wallet,
      });
      txs.push(res.signature);
    }
    if (txs.length > 0) log.info(`Claimed fees ${positionAddress.slice(0, 8)}: ${txs.at(-1).slice(0, 16)}`);
    return { success: true, txs };
  } catch (err) {
    log.error(`claimPositionFees failed: ${err.message}`);
    return { success: false, error: err.message, txs: [] };
  }
}
