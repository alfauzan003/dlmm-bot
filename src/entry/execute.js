import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import config, { BINS_BELOW, BINS_ABOVE, STRATEGY } from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { getTokenBalance, getMintDecimals } from "../solana/balances.js";
import { swapSolToToken, swapToSol } from "../solana/swap.js";
import { buildFeePlan, checkFeeCap } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getDlmmSdk } from "../meteora/sdk.js";
import { getPoolInfo } from "./pool-info.js";
import { guardPoolPrice } from "./price-guard.js";
import { trackPosition } from "../state/positions.js";
import { incrementEntryUsage, getEntryUsage, recordAction } from "./runtime.js";

const STRATEGY_ENUM = { spot: "Spot", curve: "Curve", bid_ask: "BidAsk" };

export async function executeEntry(poolAddress, signal, sizeSol, opts = {}) {
  const { countUsage = true, isDca = false } = opts;
  const { StrategyType } = await getDlmmSdk();
  const connection = getConnection();
  const wallet = getWallet();

  const { pool, baseMint, baseIsX, quoteMint, unsupported, collectFeeMode, pairName } = await getPoolInfo(poolAddress);

  if (unsupported || !baseMint) {
    return { success: false, error: `unsupported pool: pair bukan SOL (quote ${quoteMint || "?"})`, baseMint };
  }

  const split = Math.min(1, Math.max(0, Number(config.entry.sizeSplit)));
  const solSideSol = sizeSol * split;
  const tokenSideSol = sizeSol - solSideSol;

  if (sizeSol <= 0 || tokenSideSol <= 0) {
    return { success: false, error: `entry size/split invalid: size=${sizeSol}, split=${split}` };
  }

  const strategyType = StrategyType?.[STRATEGY_ENUM[STRATEGY] || "BidAsk"] ?? StrategyType?.BidAsk;
  if (strategyType === undefined) {
    return { success: false, error: `Unsupported strategy: ${STRATEGY}` };
  }

  // Baca bin aktif + rem harga. Saat deviasi di atas ambang, coba ulang beberapa
  // kali (baca ulang harga pool & pasar) sebelum menyerah. Dilakukan sebelum ada
  // SOL yang keluar. Gagal ambil harga pasar = lanjut (fail-open).
  let activeBin = null;
  if (config.entry.poolPriceCheck) {
    const label = pairName || poolAddress.slice(0, 8);
    const limit = config.entry.maxPoolPriceDeviationPct;
    const delayMs = Math.max(0, Number(config.entry.poolPriceRetryDelaySec) || 0) * 1000;
    const result = await guardPoolPrice({
      getActiveBin: () => pool.getActiveBin(),
      baseMint,
      baseIsX,
      thresholdPct: limit,
      signalTokenUsd: signal?.price,
      signalSolUsd: signal?.solPrice,
      attempts: config.entry.poolPriceMaxAttempts,
      delayMs,
      onUnavailable: (guard) =>
        log.warn(`Entry ${label}: ${guard.reason} — lanjut tanpa cek deviasi harga`),
      onRetry: ({ attempt, attempts, deviationPct }) =>
        log.warn(
          `Entry ${label}: harga pool ${deviationPct.toFixed(1)}% dari pasar (batas ${limit}%) — coba lagi ${attempt}/${attempts} dalam ${delayMs / 1000}s`
        ),
    });
    activeBin = result.activeBin;
    if (result.exhausted) {
      const dev = result.guard.deviationPct.toFixed(1);
      log.warn(
        `Entry ${label} dibatalkan: harga pool ${dev}% dari pasar setelah ${result.attempts}x percobaan (batas ${limit}%)`
      );
      return {
        success: false,
        skipped: true,
        exhausted: true,
        attempts: result.attempts,
        deviationPct: result.guard.deviationPct,
        reason: `harga pool ${dev}% dari pasar (${result.attempts}x)`,
        baseMint,
      };
    }
  } else {
    activeBin = await pool.getActiveBin();
  }

  const activeBinId = activeBin.binId;
  const minBinId = activeBinId - BINS_BELOW;
  const maxBinId = activeBinId + BINS_ABOVE;

  log.debug(
    `[detail] Entry ${pairName || poolAddress.slice(0, 8)}: ${sizeSol} SOL (SOL ${solSideSol} | token ${tokenSideSol}) bins ${minBinId}→${maxBinId} active ${activeBinId}`
  );

  if (config.dryRun) {
    return {
      success: true,
      dryRun: true,
      pool: poolAddress,
      pair: pairName,
      baseMint,
      activeBinId,
      minBinId,
      maxBinId,
      solSideSol,
      tokenSideSol,
    };
  }

  // 1. Acquire the token side via Jupiter (SOL -> base token)
  const balanceSol = (await getConnection().getBalance(wallet.publicKey)) / 1e9;
  if (balanceSol < sizeSol + Number(config.entry.gasReserve)) {
    return {
      success: false,
      error: `insufficient SOL: have ${balanceSol.toFixed(4)}, need ${(sizeSol + config.entry.gasReserve).toFixed(4)}`,
    };
  }

  // Rencana fee (priority/Jito) + cek batas biaya sebelum membeli token.
  const feePlan = buildFeePlan();
  const feeCap = checkFeeCap(feePlan);
  if (!feeCap.ok) {
    log.error(
      `Entry ${poolAddress.slice(0, 8)} dibatalkan: estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`
    );
    return {
      success: false,
      error: `estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`,
      feeCap: true,
      baseMint,
    };
  }

  const swap = await swapSolToToken(baseMint, tokenSideSol);
  if (!swap.success) {
    return {
      success: false,
      error: `token-side swap failed: ${swap.error}`,
      rateLimited: !!swap.rateLimited,
      baseMint,
    };
  }
  const baseAmountUi = swap.amountOut ?? (await getTokenBalance(baseMint));
  if (!baseAmountUi || baseAmountUi <= 0) {
    return { success: false, error: "token-side swap produced zero tokens" };
  }

  const decimals = await getMintDecimals(baseMint);
  const baseAmountRaw = new BN(Math.floor(baseAmountUi * Math.pow(10, decimals)));
  const solLamports = new BN(Math.floor(solSideSol * 1e9));

  const totalXAmount = baseIsX ? baseAmountRaw : solLamports;
  const totalYAmount = baseIsX ? solLamports : baseAmountRaw;

  // 2. Initialize position + add liquidity (double-sided, BidAsk)
  const newPosition = Keypair.generate();
  let txHash = null;
  let recovered = false;
  try {
    const tx = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user: wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: { minBinId, maxBinId, strategyType },
      slippage: config.entry.activeBinSlippagePct,
    });
    const sent = await sendAndConfirmRobust({
      connection,
      tx,
      signers: [wallet, newPosition],
      feePlan,
      wallet,
    });
    txHash = sent.signature;
  } catch (err) {
    log.error(`Entry tx failed for ${poolAddress.slice(0, 8)}: ${err.message}`);
    // Konfirmasi gagal bukan berarti tx tidak mendarat (mis. blockhash expired
    // padahal sudah masuk). Cek akun posisi sebelum me-revert token.
    let landed = false;
    try {
      landed = !!(await connection.getAccountInfo(newPosition.publicKey));
    } catch {
      landed = false;
    }
    if (landed) {
      recovered = true;
      txHash = err.signature || null;
      log.warn(
        `Entry ${pairName || poolAddress.slice(0, 8)}: konfirmasi gagal (${err.message}) tapi posisi ada on-chain — dianggap sukses`
      );
    } else {
      const orphaned = await getTokenBalance(baseMint);
      if (orphaned > 0) {
        const revert = await swapToSol(baseMint, orphaned);
        if (revert.success) {
          log.info(`Reverted ${orphaned} ${baseMint.slice(0, 8)} → SOL after failed entry`);
        } else {
          log.error(`Failed to revert ${orphaned} ${baseMint.slice(0, 8)} → SOL: ${revert.error}`);
        }
      }
      return { success: false, error: err.message, baseMint };
    }
  }

  const positionAddress = newPosition.publicKey.toString();
  const pair = pairName || `${baseMint.slice(0, 4)}-SOL`;

  trackPosition(positionAddress, poolAddress, pair, baseMint, collectFeeMode, "bidask:double", isDca);
  const uses = countUsage ? incrementEntryUsage(poolAddress) : getEntryUsage(poolAddress);

  if (isDca) {
    // Naratif DCA ditangani pemanggil (entry/dca.js) agar tidak dobel.
    log.debug(`[detail] DCA entry ${pair}: position ${positionAddress} tx ${txHash?.slice(0, 16)} (use ${uses})`);
  } else if (recovered) {
    log.info(`📌 ENTRY ${pair} — posisi terbuka (dipulihkan dari tx yang konfirmasinya gagal) — ${sizeSol} SOL`);
    recordAction(`ENTRY ${pair} — ${sizeSol} SOL`);
    tg.notifyEntry({ pair, pool: poolAddress, feeMode: feePlan.mode, feeSol: feeCap.totalSol });
  } else {
    log.info(`📌 ENTRY ${pair} — harga menyentuh garis tren → beli ${sizeSol} SOL`);
    const feeLabel = feePlan.mode !== "none" ? ` | fee ~${feeCap.totalSol.toFixed(6)} SOL (${feePlan.mode})` : "";
    log.debug(
      `[detail] pool ${poolAddress} | position ${positionAddress} | tx ${txHash?.slice(0, 16)} | use ${uses}${feeLabel}`
    );
    recordAction(`ENTRY ${pair} — ${sizeSol} SOL`);
    tg.notifyEntry({ pair, pool: poolAddress, feeMode: feePlan.mode, feeSol: feeCap.totalSol });
  }

  return {
    success: true,
    position: positionAddress,
    pool: poolAddress,
    pair,
    tx: txHash,
    recovered,
    feeMode: feePlan.mode,
    feeSol: feeCap.totalSol,
  };
}
