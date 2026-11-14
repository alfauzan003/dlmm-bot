// Ping-pong bidask flip (murni, tanpa I/O): sinyal bar 15m tutup + mesin status per trade.
// Fase:
//   first — belum flip. Tren bullish saat entry: flip saat bar 15m tutup di bawah Supertrend.
//           Bearish saat entry: auto flip pct (runAutoFlips). Begitu ada leg flip -> ask.
//   ask   — token di atas harga. Spike (bar tutup >= low terendah lookback + mult x ATR, Supertrend
//           bearish) atau semua token terjual saat bar tutup: chop masih ada -> SOL dipindah ke bawah
//           harga (reverse) -> bid; tidak -> drain.
//   bid   — SOL di bawah harga. Harga turun >= dip% dari spike, lalu bar tutup di atas high bar
//           sebelumnya -> flip token ke atas lagi -> ask (putaran berikutnya).
//   drain — tidak ada ping-pong lagi: token dibiarkan habis terjual, lalu close (trend_done).
// Supertrend berbalik bullish di ask / bid -> drain. Hanya bar tutup terbaru yang boleh memicu aksi.
import { adx, atr, bollinger } from "../market/indicators.js";
import { supertrendSeries } from "../market/supertrend.js";

export const PP_PHASES = ["first", "ask", "bid", "drain"];
const ATR_LEN = 14;
const ADX_LEN = 14;
const BB_LEN = 20;
const BB_STDDEV = 2;
const VOL_BARS_1H = 4; // 4 x 15m
const VOL_BARS_24H = 96;
const VOL_MIN_BARS = 16; // token muda: rata-rata dari bar yang ada, minimal 4 jam

export function initialPingPong() {
  return { phase: "first", entryTrend: null, round: 0, lastBar: null, spikePrice: null, lowSince: null };
}

// Rasio volume 1 jam terakhir terhadap rata-rata per jam (24 jam, atau sepanjang bar yang ada).
function volRatioAt(candles, i) {
  const n = Math.min(VOL_BARS_24H, i + 1);
  if (n < VOL_MIN_BARS) return null;
  let s1h = 0;
  let sAll = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const v = Number(candles[k].volume) || 0;
    sAll += v;
    if (k > i - VOL_BARS_1H) s1h += v;
  }
  return sAll > 0 ? s1h / (sAll / (n / VOL_BARS_1H)) : null;
}

// Satu baris per candle 15m tutup. Arah Supertrend null selama 2 x periode ATR pertama (warm-up).
export function ppRows(candles, p) {
  const closes = candles.map((c) => c.close);
  const st = supertrendSeries(candles, p.ppStAtrPeriod, p.ppStMultiplier);
  const a = atr(candles, ATR_LEN);
  const dx = adx(candles, ADX_LEN);
  const bb = bollinger(closes, BB_LEN, BB_STDDEV);
  const L = Math.max(1, p.ppSpikeLookbackBars);
  return candles.map((c, i) => {
    const lowest = i >= L - 1 ? Math.min(...candles.slice(i - L + 1, i + 1).map((x) => x.low)) : null;
    return {
      time: c.time,
      high: c.high,
      low: c.low,
      close: c.close,
      prevHigh: i > 0 ? candles[i - 1].high : null,
      direction: i < 2 * p.ppStAtrPeriod ? null : (st[i]?.direction ?? null),
      line: st[i]?.line ?? null,
      atr: a[i],
      adx: dx[i],
      bbWidthPct: bb.middle[i] > 0 ? ((bb.upper[i] - bb.lower[i]) / bb.middle[i]) * 100 : null,
      spikeFloor: lowest != null && a[i] != null ? lowest + p.ppSpikeAtrMult * a[i] : null,
      volRatio: volRatioAt(candles, i),
    };
  });
}

export function isSpike(row) {
  return row?.direction === "bearish" && row.spikeFloor != null && row.close >= row.spikeFloor;
}

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "?");
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "?");

// Kondisi lanjut ping-pong (chop masih ada). Ambang 0 = syarat itu mati; nilai tidak diketahui = gagal.
export function chopCheck(row, p) {
  const fails = [];
  if (p.ppMinBbWidthPct > 0 && !(row.bbWidthPct >= p.ppMinBbWidthPct))
    fails.push(`BB width ${f1(row.bbWidthPct)}% < ${p.ppMinBbWidthPct}%`);
  if (p.ppMaxAdx > 0 && !(row.adx < p.ppMaxAdx)) fails.push(`ADX ${f1(row.adx)} ≥ ${p.ppMaxAdx}`);
  if (p.ppMinVolRatio > 0 && !(row.volRatio >= p.ppMinVolRatio))
    fails.push(`1h volume ${f2(row.volRatio)}x < ${p.ppMinVolRatio}x of the 24h average`);
  const ok = fails.length === 0;
  const why = ok
    ? `BB width ${f1(row.bbWidthPct)}%, ADX ${f1(row.adx)}, 1h volume ${f2(row.volRatio)}x`
    : fails.join(", ");
  return { ok, why };
}

// Satu langkah. ctx.flipped = trade sudah punya leg flip; ctx.allSold = harga di atas semua leg (semua SOL).
// Hasil: { state, fire, drained }. fire = { action: "flip" | "reverse", time, price, why } — state.lastBar
// tetap sebelum bar pemicu (aksi gagal karena sibuk dicoba lagi tick berikutnya); commitPingPong
// menerapkan hasil aksinya. drained = { reason, detail } saat fase berpindah ke drain di langkah ini.
export function stepPingPong(state, rows, p, { flipped = false, allSold = false } = {}) {
  const s = { ...initialPingPong(), ...(state || {}) };
  const out = (fire = null, drained = null) => ({ state: s, fire, drained });
  if (s.phase === "drain") return out();
  if (s.phase === "first" && flipped) {
    s.phase = "ask";
    s.round = Math.max(1, s.round);
  }
  const newest = rows?.length ? rows[rows.length - 1] : null;
  if (!newest) return out();

  if (s.phase === "first") {
    if (s.entryTrend == null) {
      s.entryTrend = newest.direction === "bullish" ? "bullish" : "bearish";
      s.lastBar = newest.time;
      return out();
    }
    if (s.lastBar != null && newest.time <= s.lastBar) return out();
    if (s.entryTrend === "bullish" && newest.direction === "bearish") {
      return out({ action: "flip", time: newest.time, price: newest.close, why: "st_break" });
    }
    s.lastBar = newest.time;
    return out();
  }

  // Belum pernah mengevaluasi bar (mis. flip pertama terjadi sebelum candle termuat): mulai dari bar terbaru.
  for (const row of s.lastBar == null ? [newest] : rows) {
    if (s.lastBar != null && row.time <= s.lastBar) continue;
    const isNewest = row === newest;
    if (s.phase === "bid") s.lowSince = Math.min(s.lowSince ?? s.spikePrice ?? row.low, row.low);
    if (row.direction === "bullish") {
      s.phase = "drain";
      s.lastBar = row.time;
      return out(null, { reason: "trend_up", detail: "15m Supertrend turned bullish" });
    }
    if (isNewest && s.phase === "ask") {
      const spike = isSpike(row);
      if (spike || allSold) {
        const why = spike
          ? `spike: close ${row.close.toPrecision(4)} ≥ ${row.spikeFloor.toPrecision(4)} (low + ${p.ppSpikeAtrMult} ATR)`
          : "all tokens sold at the bar close";
        const chop = chopCheck(row, p);
        if (chop.ok) return out({ action: "reverse", time: row.time, price: row.close, why: `${why}; ${chop.why}` });
        s.phase = "drain";
        s.lastBar = row.time;
        return out(null, { reason: "weak", detail: `${why}; chop gone: ${chop.why}` });
      }
    }
    if (isNewest && s.phase === "bid") {
      const floor = s.spikePrice * (1 - p.ppDipMinPct / 100);
      if (s.lowSince <= floor && row.prevHigh != null && row.close > row.prevHigh) {
        const dip = (1 - s.lowSince / s.spikePrice) * 100;
        return out({
          action: "flip",
          time: row.time,
          price: row.close,
          why: `dipped ${dip.toFixed(1)}% from the spike, close ${row.close.toPrecision(4)} > previous high ${row.prevHigh.toPrecision(4)}`,
        });
      }
    }
    s.lastBar = row.time;
  }
  return out();
}

// Terapkan hasil aksi: "done" (sukses / dry run), "skip" (tidak ada yang dipindah — tunggu sinyal
// berikutnya), "stuck" (dana tertarik tapi setor ulang gagal, atau batas posisi) -> drain.
export function commitPingPong(state, fire, outcome) {
  const s = { ...initialPingPong(), ...(state || {}), lastBar: fire.time };
  if (outcome === "stuck") return { ...s, phase: "drain" };
  if (outcome !== "done") return s;
  if (fire.action === "reverse") return { ...s, phase: "bid", spikePrice: fire.price, lowSince: fire.price };
  return { ...s, phase: "ask", round: (s.round || 0) + 1, spikePrice: null, lowSince: null };
}

export function samePingPong(a, b) {
  return JSON.stringify({ ...initialPingPong(), ...(a || {}) }) === JSON.stringify({ ...initialPingPong(), ...(b || {}) });
}
