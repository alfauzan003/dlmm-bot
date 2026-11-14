// Sinyal entry bidask flip + lebar range (murni, tanpa I/O): Fibonacci retracement ATL -> ATH.
// Level L ada di harga ATH − L·(ATH − ATL): 0 = ATH, 1 = ATL.
import { BIN_PER_POSITION, binsForPct } from "./screen.js";

export { binsForPct };

// Pct terbesar yang range-nya masih `bins` bin (termasuk bin aktif).
export function maxPctForBins(bins, binStep) {
  return (1 - (1 + binStep / 10000) ** -(bins - 1)) * 100;
}

// ATH / ATL dari beberapa seri bar (high / low); null bila tidak ada bar valid.
export function athAtl(...series) {
  let ath = -Infinity;
  let atl = Infinity;
  for (const bars of series) {
    for (const b of bars || []) {
      if (Number.isFinite(b.high) && b.high > 0) ath = Math.max(ath, b.high);
      if (Number.isFinite(b.low) && b.low > 0) atl = Math.min(atl, b.low);
    }
  }
  return Number.isFinite(ath) && Number.isFinite(atl) && ath > atl ? { ath, atl } : null;
}

export const fibPrice = (ath, atl, level) => ath - level * (ath - atl);

// Entry bila harga sudah turun ke / di bawah level entry (default 0.382). maxPct = jarak (%) level entry -> level dalam.
export function fibSignal({ ath, atl, price }, p) {
  if (!(ath > atl) || !(atl > 0) || !(price > 0)) return { enter: false, reason: "no_history", metrics: null };
  const fibEntry = fibPrice(ath, atl, p.fibEntryLevel);
  const fibDeep = fibPrice(ath, atl, p.fibDeepLevel);
  const maxPct = ((fibEntry - fibDeep) / fibEntry) * 100;
  const metrics = { ath, atl, price, fibEntry, fibDeep, maxPct };
  if (price > fibEntry) return { enter: false, reason: "above_fib", metrics };
  return { enter: true, reason: "signal", metrics };
}

const f1 = (v) => `${v.toFixed(1)}%`;

// target = min + (min(vol, cap) / cap) · (max − min), lalu muat di maxPositions·70 bin. pct null = dilewati.
export function explainRangePct({ maxPct, volatility }, p, binStep) {
  if (!Number.isFinite(volatility)) return { pct: null, why: "volatility n/a" };
  if (!Number.isFinite(maxPct)) return { pct: null, why: "max range n/a" };
  const cap = p.volatilityCap > 0 ? p.volatilityCap : 10;
  const v = Math.min(Math.max(volatility, 0), cap);
  let pct = p.rangeMinPct + (v / cap) * (maxPct - p.rangeMinPct);
  const steps = [`vol ${v.toFixed(2)}/${cap} · min ${f1(p.rangeMinPct)} · max ${f1(maxPct)} → ${f1(pct)}`];
  const binCap = maxPctForBins(p.maxPositions * BIN_PER_POSITION, binStep);
  if (pct > binCap) {
    pct = binCap;
    steps.push(`capped by ${p.maxPositions} position(s) × ${BIN_PER_POSITION} bins @ bin step ${binStep} = ${f1(binCap)}`);
  }
  if (!(pct > 0) || pct >= 100) {
    steps.push("not a valid range → skip");
    return { pct: null, why: steps.join(" · ") };
  }
  return { pct, why: steps.join(" · ") };
}
