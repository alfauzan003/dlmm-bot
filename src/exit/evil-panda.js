// Exit Evil Panda per trade (murni): tahan selama harga di atas Supertrend 15m; setelah bar tutup
// menembus ke bawah (armed), close pada spike berikutnya (RSI / MACD / BB yang aktif). Bar yang tutup
// kembali di atas Supertrend membatalkan arming. Hanya bar 15m yang sudah tutup yang dipakai.
import { bollinger, macd, rsi } from "../market/indicators.js";
import { supertrendSeries } from "../market/supertrend.js";

const BAR_SEC = 900;
const barStart = (sec) => Math.floor(sec / BAR_SEC) * BAR_SEC;

// Candle yang sudah tutup saja. null bila bar tutup terakhir belum ada (data belum final).
export function closedBars(candles, nowMs = Date.now()) {
  const current = barStart(nowMs / 1000);
  const closed = (candles || []).filter((c) => barStart(c.time) < current);
  if (closed.length === 0 || barStart(closed[closed.length - 1].time) !== current - BAR_SEC) return null;
  return closed;
}

// Satu baris per candle: arah Supertrend + nilai sinyal. Arah null selama 2×periode ATR pertama
// (warm-up Supertrend belum stabil); MACD null bila slow <= fast.
export function pandaRows(candles, params) {
  const closes = candles.map((c) => c.close);
  const st = supertrendSeries(candles, params.stAtrPeriod, params.stMultiplier);
  const r = rsi(closes, params.rsi.length);
  const m =
    params.macd.slow > params.macd.fast ? macd(closes, params.macd.fast, params.macd.slow, params.macd.signal) : null;
  const bb = bollinger(closes, params.bb.length, params.bb.stdDev);
  return candles.map((c, i) => ({
    time: c.time,
    close: c.close,
    direction: i < 2 * params.stAtrPeriod ? null : (st[i]?.direction ?? null),
    rsi: r[i],
    hist: m?.hist[i] ?? null,
    prevHist: i > 0 ? (m?.hist[i - 1] ?? null) : null,
    upper: bb.upper[i],
  }));
}

function signalOf(row, params) {
  if (params.rsi.on && row.rsi != null && row.rsi > params.rsi.level) return "rsi";
  if (params.macd.on && row.hist != null && row.prevHist != null && row.hist > 0 && row.prevHist <= 0) return "macd";
  if (params.bb.on && row.upper != null && row.close > row.upper) return "bb";
  return null;
}

// Proses bar setelah progress.lastBar (pertama kali: mulai bar saat trade dibuka). Saat terpicu,
// lastBar tetap di bar sebelumnya supaya close yang gagal dicoba lagi tick berikutnya.
export function stepPanda(progress, rows, params, { openedAtSec = 0 } = {}) {
  const next = { seenAbove: false, armed: false, lastBar: null, ...(progress || {}) };
  const from = next.lastBar == null ? barStart(openedAtSec) : next.lastBar + 1;
  for (const row of rows) {
    if (row.time < from) continue;
    if (row.direction === "bullish") {
      next.seenAbove = true;
      next.armed = false;
    } else if (row.direction === "bearish" && next.seenAbove) {
      next.armed = true;
      const signal = signalOf(row, params);
      if (signal) return { progress: next, fire: { signal, time: row.time } };
    }
    next.lastBar = row.time;
  }
  return { progress: next, fire: null };
}
