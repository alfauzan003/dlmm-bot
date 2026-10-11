import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { buildFeePlan, checkFeeCap } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getDlmmSdk } from "../meteora/sdk.js";
import { getPoolInfo } from "../entry/pool-info.js";
import { addEntryInProgressPool, removeEntryInProgressPool, recordAction } from "../entry/runtime.js";
import {
  trackPosition,
  recordTrackedRange,
  getTrackedPosition,
  getSpotReentryCount,
  setSpotReentryCount,
} from "../state/positions.js";

// Guard per-posisi: cegah re-entry jalan dobel untuk posisi yang sama.
const reentryInProgress = new Set();

// Pure: range spot SOL-only satu-sisi, `binSpan` bin di bawah harga aktif.
// Anchor selalu ke active bin (harga sekarang), jadi persentase range tetap.
export function reentryBinRange(activeBinId, binSpan) {
  const active = Math.floor(Number(activeBinId));
  const span = Math.max(0, Math.floor(Number(binSpan) || 0));
  return { minBinId: active - span, maxBinId: active };
}

// Pure: total biaya NON-REFUNDABLE dari quoteCreatePosition (SOL). Sewa bin
// array / bitmap extension hangus; sewa akun posisi (refundable) tidak dihitung.
export function nonRefundableCost(quote) {
  const binArray = Number(quote?.binArrayCost) || 0;
  const bitmap = Number(quote?.bitmapExtensionCost) || 0;
  return binArray + bitmap;
}

// Pure: apakah biaya non-refundable melewati batas yang diizinkan.
export function exceedsNonRefundable(cost, maxSol) {
  const c = Number(cost) || 0;
  const m = Number.isFinite(Number(maxSol)) ? Math.max(0, Number(maxSol)) : 0;
  return c > m;
}

// Pure: putuskan apakah posisi yang mau ditutup layak di-re-entry.
export function shouldReenter({ mode, reason, span, count, cfg }) {
  if (!cfg?.enabled || !(cfg.sizeSol > 0)) return false;
  if (mode !== "spot" || reason !== "oor_kanan") return false;
  const s = Number(span);
  if (!Number.isFinite(s) || s <= 0) return false;
  const c = Number(count) || 0;
  return c < cfg.maxReentries;
}

// Baca state posisi lalu nilai kelayakan re-entry (dipakai loop exit).
export function canSpotReenter(pos, reason) {
  if (!pos?.position) return false;
  const tracked = getTrackedPosition(pos.position);
  return shouldReenter({
    mode: pos.mode,
    reason,
    span: tracked?.binSpan,
    count: getSpotReentryCount(pos.position),
    cfg: config.spotReentry,
  });
}

// OOR kanan spot: buka posisi spot SOL-only baru di harga aktif dengan jumlah
// bin ke bawah sama seperti posisi yang barusan ditutup. Return true bila
// posisi baru berhasil dibuka (atau dry-run).
export async function handleSpotOorKananReentry(pos) {
  const cfg = config.spotReentry;
  const pair = pos?.pair || pos?.position?.slice(0, 8) || "?";
  if (!cfg?.enabled || !pos?.position || pos.mode !== "spot" || !pos.pool) return false;

  if (reentryInProgress.has(pos.position)) {
    log.info(`Re-entry ${pair}: sudah diproses, lewati`);
    return true;
  }

  const tracked = getTrackedPosition(pos.position);
  const span = Number(tracked?.binSpan);
  if (!Number.isFinite(span) || span <= 0) {
    log.warn(`Re-entry ${pair}: binSpan tidak tercatat — dilewati`);
    return false;
  }

  const prevCount = getSpotReentryCount(pos.position);
  if (prevCount >= cfg.maxReentries) {
    log.info(`Re-entry ${pair}: batas ${cfg.maxReentries}x tercapai — berhenti`);
    recordAction(`RE-ENTRY ${pair} — batas ${cfg.maxReentries}x tercapai`);
    return false;
  }

  const nextCount = prevCount + 1;

  if (config.dryRun) {
    log.info(
      `[DRY RUN] Would re-entry ${pair} — ${cfg.sizeSol} SOL, ${span} bin ke bawah (${nextCount}/${cfg.maxReentries})`
    );
    return true;
  }

  reentryInProgress.add(pos.position);
  addEntryInProgressPool(pos.pool);

  try {
    const { pool, baseMint, baseIsX, unsupported, collectFeeMode, pairName } = await getPoolInfo(pos.pool);
    if (unsupported || !baseMint) {
      return fail(pair, pos.pool, cfg, nextCount, "pool bukan pair SOL / tidak didukung");
    }

    const { StrategyType } = await getDlmmSdk();
    const strategyType = StrategyType?.Spot;
    if (strategyType === undefined) {
      return fail(pair, pos.pool, cfg, nextCount, "StrategyType.Spot tidak tersedia");
    }

    const activeBin = await pool.getActiveBin();
    const { minBinId, maxBinId } = reentryBinRange(activeBin.binId, span);

    // Cek biaya NON-REFUNDABLE (sewa bin array/bitmap baru) sebelum keluar SOL.
    // Gagal cek = fail-closed (batal), agar tidak kena biaya hangus.
    if (cfg.skipNonRefundable) {
      let quote;
      try {
        quote = await pool.quoteCreatePosition({ strategy: { minBinId, maxBinId } });
      } catch (err) {
        const brief = String(err.message || err).split("\n")[0];
        return fail(pair, pos.pool, cfg, nextCount, `gagal cek biaya non-refundable: ${brief}`);
      }
      const cost = nonRefundableCost(quote);
      if (exceedsNonRefundable(cost, cfg.maxNonRefundableSol)) {
        return fail(
          pair,
          pos.pool,
          cfg,
          nextCount,
          `biaya non-refundable ${cost.toFixed(6)} SOL (${quote?.binArraysCount || 0} bin array)`
        );
      }
    }

    const connection = getConnection();
    const wallet = getWallet();

    const balanceSol = (await connection.getBalance(wallet.publicKey)) / 1e9;
    const need = cfg.sizeSol + Number(config.entry.gasReserve);
    if (balanceSol < need) {
      return fail(
        pair,
        pos.pool,
        cfg,
        nextCount,
        `saldo SOL tidak cukup (punya ${balanceSol.toFixed(4)}, butuh ${need.toFixed(4)})`
      );
    }

    const feePlan = buildFeePlan();
    const feeCap = checkFeeCap(feePlan);
    if (!feeCap.ok) {
      return fail(
        pair,
        pos.pool,
        cfg,
        nextCount,
        `estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`
      );
    }

    const lamports = new BN(Math.floor(cfg.sizeSol * 1e9));
    const totalXAmount = baseIsX ? new BN(0) : lamports;
    const totalYAmount = baseIsX ? lamports : new BN(0);

    const label = pairName || pair;
    log.debug(
      `[detail] Re-entry ${label}: ${cfg.sizeSol} SOL bins ${minBinId}→${maxBinId} active ${activeBin.binId} (${nextCount}/${cfg.maxReentries})`
    );

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
        return fail(pair, pos.pool, cfg, nextCount, err.message);
      }
      txHash = err.signature || null;
      log.warn(`Re-entry ${label}: konfirmasi gagal (${err.message}) tapi posisi ada on-chain — dianggap sukses`);
    }

    const positionAddress = newPosition.publicKey.toString();
    const pairLabel = pairName || pos.pair || `${baseMint.slice(0, 4)}-SOL`;
    trackPosition(positionAddress, pos.pool, pairLabel, baseMint, collectFeeMode, "spot");
    setSpotReentryCount(positionAddress, nextCount);
    recordTrackedRange(positionAddress, minBinId, maxBinId);

    log.info(`🔁 RE-ENTRY ${pairLabel} — ${cfg.sizeSol} SOL | ${span} bin ke bawah (${nextCount}/${cfg.maxReentries})`);
    log.debug(`[detail] position ${positionAddress} | tx ${txHash?.slice(0, 16)}`);
    recordAction(`RE-ENTRY ${pairLabel} — ${cfg.sizeSol} SOL (${nextCount}/${cfg.maxReentries})`);
    tg.notifySpotReentry({
      pair: pairLabel,
      pool: pos.pool,
      sizeSol: cfg.sizeSol,
      attempt: nextCount,
      max: cfg.maxReentries,
      bins: span,
      success: true,
    });

    return true;
  } catch (err) {
    return fail(pair, pos.pool, cfg, nextCount, err.message);
  } finally {
    removeEntryInProgressPool(pos.pool);
    reentryInProgress.delete(pos.position);
  }
}

// Log + notif kegagalan re-entry (menghentikan rantai).
function fail(pair, pool, cfg, attempt, error) {
  const brief = String(error || "unknown").split("\n")[0];
  log.warn(`Re-entry ${pair} gagal (${attempt}/${cfg.maxReentries}): ${brief} — rantai dihentikan`);
  recordAction(`RE-ENTRY ${pair} GAGAL — ${brief}`);
  tg.notifySpotReentry({
    pair,
    pool,
    sizeSol: cfg.sizeSol,
    attempt,
    max: cfg.maxReentries,
    success: false,
    error: brief,
  });
  return false;
}
