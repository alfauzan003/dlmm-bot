import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { getMintDecimals } from "../solana/balances.js";
import { buildFeePlan, checkFeeCap } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getDlmmSdk } from "./sdk.js";
import { getPoolInfo } from "../entry/pool-info.js";
import { trackPosition } from "../state/positions.js";

const STRATEGY_ENUM = { spot: "Spot", curve: "Curve", bid_ask: "BidAsk" };

// Pure: rentang bin satu-sisi untuk fallback token-only.
// `binsBelow` bin di bawah harga aktif, `binsAbove` bin di atasnya.
export function fallbackBinRange(activeBinId, binsBelow, binsAbove) {
  const below = Math.max(0, Math.floor(Number(binsBelow) || 0));
  const above = Math.max(0, Math.floor(Number(binsAbove) || 0));
  return { minBinId: activeBinId - below, maxBinId: activeBinId + above };
}

// Buka posisi token-only satu-sisi memakai saldo token yang sudah dimiliki.
// Tidak ada pembelian token (tanpa Jupiter). Dipakai fallback OOR kiri spot.
export async function openTokenOnlyPosition({
  poolAddress,
  baseMint,
  tokenAmountUi,
  binsAbove,
  binsBelow,
  distribution = "bid_ask",
  pairName = null,
} = {}) {
  if (!poolAddress || !baseMint) {
    return { success: false, error: "pool/baseMint kosong" };
  }
  const amountUi = Number(tokenAmountUi);
  if (!Number.isFinite(amountUi) || amountUi <= 0) {
    return { success: false, error: `saldo token tidak valid (${tokenAmountUi})` };
  }

  const { StrategyType } = await getDlmmSdk();
  const connection = getConnection();
  const wallet = getWallet();

  const { pool, baseIsX, collectFeeMode, pairName: poolPair } = await getPoolInfo(poolAddress);
  if (!pool) {
    return { success: false, error: "pool tidak ditemukan" };
  }

  const activeBin = await pool.getActiveBin();
  const activeBinId = activeBin.binId;
  const { minBinId, maxBinId } = fallbackBinRange(activeBinId, binsBelow, binsAbove);

  const strategyType = StrategyType?.[STRATEGY_ENUM[distribution] || "BidAsk"] ?? StrategyType?.BidAsk;
  if (strategyType === undefined) {
    return { success: false, error: `distribusi tidak dikenal: ${distribution}` };
  }

  const label = pairName || poolPair || poolAddress.slice(0, 8);
  log.debug(
    `[detail] Fallback token-only ${label}: ${amountUi} token bins ${minBinId}→${maxBinId} active ${activeBinId} (${distribution})`
  );

  if (config.dryRun) {
    return {
      success: true,
      dryRun: true,
      pool: poolAddress,
      pair: label,
      baseMint,
      activeBinId,
      minBinId,
      maxBinId,
    };
  }

  // Fee plan + batas biaya sebelum transaksi.
  const feePlan = buildFeePlan();
  const feeCap = checkFeeCap(feePlan);
  if (!feeCap.ok) {
    log.error(
      `Fallback ${poolAddress.slice(0, 8)} dibatalkan: estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`
    );
    return { success: false, error: `estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap`, feeCap: true };
  }

  const decimals = await getMintDecimals(baseMint);
  const tokenRaw = new BN(Math.floor(amountUi * Math.pow(10, decimals)));
  const totalXAmount = baseIsX ? tokenRaw : new BN(0);
  const totalYAmount = baseIsX ? new BN(0) : tokenRaw;

  const newPosition = Keypair.generate();
  let txHash = null;
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
    // Konfirmasi gagal bukan berarti tx tidak mendarat.
    let landed = false;
    try {
      landed = !!(await connection.getAccountInfo(newPosition.publicKey));
    } catch {
      landed = false;
    }
    if (!landed) {
      log.error(`Fallback token-only tx gagal untuk ${poolAddress.slice(0, 8)}: ${err.message}`);
      return { success: false, error: err.message, baseMint };
    }
    txHash = err.signature || null;
    log.warn(`Fallback ${label}: konfirmasi gagal (${err.message}) tapi posisi ada on-chain — dianggap sukses`);
  }

  const positionAddress = newPosition.publicKey.toString();
  const pair = pairName || poolPair || `${baseMint.slice(0, 4)}-SOL`;
  trackPosition(positionAddress, poolAddress, pair, baseMint, collectFeeMode, "bidask:token");

  log.info(`📌 FALLBACK token-only ${pair} — posisi ${positionAddress.slice(0, 8)} (${amountUi} token)`);
  tg.notifyEntry({ pair, pool: poolAddress, feeMode: feePlan.mode, feeSol: feeCap.totalSol });

  return {
    success: true,
    position: positionAddress,
    pool: poolAddress,
    pair,
    tx: txHash,
    feeMode: feePlan.mode,
    feeSol: feeCap.totalSol,
  };
}
