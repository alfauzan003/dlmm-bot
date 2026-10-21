// Sinyal entry + pemilihan range Auto Entry (murni, tanpa I/O). Bar 5m tertutup, terlama dulu.
import { BIN_PER_POSITION, binsForPct } from "./screen.js";

export { binsForPct };

const BAR_MIN = 5;

// Pct terbesar yang range-nya masih `bins` bin (termasuk bin aktif).
export function maxPctForBins(bins, binStep) {
  return (1 - (1 + binStep / 10000) ** -(bins - 1)) * 100;
}

export function barsNeeded(p) {
  const pump = Math.ceil(p.pumpLookbackMin / BAR_MIN) + 1;
  const support = p.rangeMode === "support" ? Math.ceil(p.supportLookbackMin / BAR_MIN) + 1 : 0;
  return Math.max(pump, support, 7);
}

// pumpPct = (high/base − 1)·100, pullbackPct = (1 − close/high)·100.
export function entrySignal(bars, p) {
  if (p.entryTiming === "immediate") {
    return bars.length ? { enter: true, reason: "immediate", metrics: null } : { enter: false, reason: "not_enough_bars", metrics: null };
  }
  const w = Math.ceil(p.pumpLookbackMin / BAR_MIN);
  if (bars.length < w) return { enter: false, reason: "not_enough_bars", metrics: null };
  const win = bars.slice(-w);
  const base = win[0].open;
  const high = Math.max(...win.map((b) => b.high));
  const last = win[win.length - 1];
  const close = last.close;
  const pumpPct = (high / base - 1) * 100;
  const pullbackPct = (1 - close / high) * 100;
  const metrics = { pumpPct, pullbackPct, high, base, close };
  const no = (reason) => ({ enter: false, reason, metrics });
  if (pumpPct < p.minPumpPct) return no("no_pump");
  if (pullbackPct < p.minPullbackPct) return no("pullback_small");
  if (pullbackPct > p.maxPullbackPct) return no("pullback_large");
  if (!(last.close < last.open)) return no("not_red");
  return { enter: true, reason: "signal", metrics };
}

// Lebar range (% turun dari harga) dibatasi min/max, lalu muat di maxPositions·70 bin; null jika min tak muat.
export function pickRangePct(bars, p, binStep) {
  let pct = p.rangePct;
  if (p.rangeMode === "support" && bars.length) {
    const n = Math.ceil(p.supportLookbackMin / BAR_MIN);
    const support = Math.min(...bars.slice(-n).map((b) => b.low));
    const close = bars[bars.length - 1].close;
    pct = support >= close ? p.rangeMinPct : (1 - support / close) * 100 + p.supportBufferPct;
  }
  pct = Math.min(Math.max(pct, p.rangeMinPct), p.rangeMaxPct);
  pct = Math.min(pct, maxPctForBins(p.maxPositions * BIN_PER_POSITION, binStep));
  return pct < p.rangeMinPct ? null : pct;
}
