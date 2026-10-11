import config from "../config/index.js";
import { computeRSI, computeMACD, computeBB } from "../market/indicators.js";
import {
  updateOOR,
  resetOOR,
  getOORState,
  setLowYieldSince,
  getLowYieldSince,
  clearLowYieldSince,
} from "../state/positions.js";
import { isTrailingConfirmed } from "../state/trailing.js";
import { getBounceRecoveryState } from "../state/bounce.js";

// Pure: masih dalam masa warmup exit? (trailing & arm indikator ditahan)
export function isExitWarmup(firstSeenAt, warmupMinutes, now = Date.now()) {
  const min = Number(warmupMinutes);
  if (!Number.isFinite(min) || min <= 0) return false;
  if (!Number.isFinite(Number(firstSeenAt))) return false;
  return now - Number(firstSeenAt) < min * 60000;
}

export function evaluateExit(position, candles, { warmup = false } = {}) {
  const rules = config.rulesFor(position.mode);
  const { activeBin, lowerBin, upperBin, pnlPct } = position;

  const baseIsX = !position.xIsSol;
  const hasBase = baseIsX ? position.hasX : position.hasY;
  const inRange =
    activeBin != null && lowerBin != null && upperBin != null && activeBin >= lowerBin && activeBin <= upperBin;
  // Timer yield rendah hanya relevan saat in-range; keluar range = reset.
  if (!inRange) clearLowYieldSince(position.position);

  // 1. Stop loss
  if (rules.enableStopLoss && pnlPct != null && pnlPct <= rules.stopLossPct) {
    resetOOR(position.position);
    return { action: "close", reason: "stop_loss" };
  }

  // 2. OOR kanan — mode dengan masa tunggu (mis. spot) pakai timer; batal bila
  // harga kembali masuk range. Mode lain (oorKananMinutes = 0) tutup langsung.
  if (activeBin != null && upperBin != null && activeBin > upperBin) {
    if (rules.oorKananMinutes > 0) {
      updateOOR(position.position, "kanan");
      const oorState = getOORState(position.position);
      const menit = oorState ? (Date.now() - oorState.sejak) / 60000 : 0;
      if (menit >= rules.oorKananMinutes) {
        resetOOR(position.position);
        return { action: "close", reason: "oor_kanan" };
      }
      return { action: "hold", reason: `oor_kanan_${Math.floor(menit)}m` };
    }
    resetOOR(position.position);
    return { action: "close", reason: "oor_kanan" };
  }

  // 3. Trailing TP terkonfirmasi (peak-based atau indicator-armed)
  const trailingReason = isTrailingConfirmed(position.position);
  if (trailingReason) {
    resetOOR(position.position);
    return { action: "close", reason: trailingReason };
  }

  // 4. OOR kiri (opsional, timer)
  if (rules.enableOOR && activeBin != null && lowerBin != null && activeBin < lowerBin) {
    updateOOR(position.position, "kiri");
    const oorState = getOORState(position.position);
    const menit = oorState ? (Date.now() - oorState.sejak) / 60000 : 0;

    if (menit >= rules.oorKiriMinutes) {
      resetOOR(position.position);
      return { action: "close", reason: "oor_kiri" };
    }

    return { action: "hold", reason: `oor_kiri_${Math.floor(menit)}m` };
  }

  // In-range: reset tracker
  resetOOR(position.position);

  // 5. Yield rendah (mode spot): in-range + sudah pegang token, yield <= ambang,
  // dan PnL >= 0. Setelah `lowYieldDelayMinutes` kondisi bertahan → close + swap.
  if (rules.lowYieldClosePct > 0 && inRange && hasBase === true) {
    const hasYieldData = Number.isFinite(position.feePct24h);
    const low = hasYieldData && position.feePct24h <= rules.lowYieldClosePct;
    if (low && pnlPct != null && pnlPct >= 0) {
      setLowYieldSince(position.position);
      const sejak = getLowYieldSince(position.position);
      const menit = sejak ? (Date.now() - sejak) / 60000 : 0;
      if (menit >= rules.lowYieldDelayMinutes) {
        clearLowYieldSince(position.position);
        return { action: "close", reason: "low_yield" };
      }
      return { action: "hold", reason: `low_yield_${Math.floor(menit)}m` };
    }
    clearLowYieldSince(position.position);
  } else {
    clearLowYieldSince(position.position);
  }

  // 6. Bounce recovery trail stop (opsional)
  if (rules.enableBounceRecovery && pnlPct != null) {
    const brState = getBounceRecoveryState(position.position);
    if (brState?.state === "active" && brState.activePeak != null) {
      const trigger = brState.activePeak - rules.bounceRecoveryTrailingPct;
      if (pnlPct <= trigger) {
        return {
          action: "close",
          reason: `bounce_recovery: peak ${brState.activePeak.toFixed(2)}% -> ${pnlPct.toFixed(2)}%`,
        };
      }
    }
  }

  // 7. Indikator — arm trailing saat RSI+MACD atau RSI+BB (exit via trailing drop).
  // Selama warmup, sinyal indikator diabaikan agar posisi yang baru dibuka
  // (mis. di puncak) tidak langsung ter-arm.
  if (!rules.enableIndicators || warmup) {
    return { action: "hold", reason: warmup ? "warmup" : "indicators_disabled" };
  }

  // Selalu pakai candle yang sudah tutup. GMGN/Meteora menyertakan bar
  // berjalan sebagai candle terakhir; buang agar indikator tidak dihitung
  // dari data yang belum final.
  const closed = closedCandles(candles);
  if (closed.length < 5) {
    return { action: "hold", reason: "insufficient_data" };
  }

  const closes = closed.map((c) => c.close);
  const rsiValues = computeRSI(closes, rules.rsiPeriod);
  const macd = computeMACD(closes, rules.macdFast, rules.macdSlow, rules.macdSignal);
  const bb = computeBB(closes, rules.bbPeriod, rules.bbStddev);

  const rsiLatest = rsiValues[rsiValues.length - 1];
  const highLatest = closed[closed.length - 1]?.high;

  const reason = detectIndicatorSignal({
    rsiLatest,
    macdGreen: macd.macdGreen,
    bbUpper: bb.upper,
    highLatest,
  });

  if (reason) {
    return { action: "arm_indicator_trailing", reason };
  }

  return { action: "hold", reason: "no_signal" };
}

// Pure: buang candle berjalan (terakhir) sehingga hanya candle yang sudah
// tutup yang dipakai. Data candle dari sumber selalu menyertakan bar aktif.
export function closedCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return [];
  return candles.slice(0, -1);
}

// Pure: pilih reason sinyal indikator dari nilai yang sudah dihitung.
// Urutan dipertahankan: rsi_macd -> rsi_bb. Sinyal RSI+MACD = RSI(2) >= 90 dan
// bar MACD hijau (hist > 0), tanpa peduli warna bar sebelumnya, keduanya pada
// candle t yang sama.
// Sinyal RSI+BB = RSI(2) >= 90 dan high candle (yang sudah tutup) menembus BB upper.
export function detectIndicatorSignal({ rsiLatest, macdGreen, bbUpper, highLatest }) {
  if (!(rsiLatest >= 90)) return null;
  if (macdGreen) return "rsi_macd";
  if (bbUpper == null) return null;
  if (highLatest != null && highLatest >= bbUpper) return "rsi_bb";
  return null;
}
