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

const f1 = (v) => `${v.toFixed(1)}%`;

// Seperti pickRangePct, plus `why`: langkah-langkah yang menghasilkan pct (untuk log / alert).
export function explainRangePct(bars, p, binStep) {
  let pct = p.rangePct;
  const steps = [];
  if (p.rangeMode === "support" && bars.length) {
    const n = Math.ceil(p.supportLookbackMin / BAR_MIN);
    const support = Math.min(...bars.slice(-n).map((b) => b.low));
    const close = bars[bars.length - 1].close;
    if (support >= close) {
      pct = p.rangeMinPct;
      steps.push(`support mode: lowest low ${p.supportLookbackMin}m ≥ close → min ${f1(pct)}`);
    } else {
      const dist = (1 - support / close) * 100;
      pct = dist + p.supportBufferPct;
      steps.push(
        `support mode: lowest low ${p.supportLookbackMin}m ${support.toPrecision(4)} vs close ${close.toPrecision(4)} → ${f1(dist)} + buffer ${p.supportBufferPct}% = ${f1(pct)}`
      );
    }
  } else {
    steps.push(`fixed ${f1(pct)}`);
  }
  if (pct < p.rangeMinPct) {
    pct = p.rangeMinPct;
    steps.push(`raised to min ${f1(pct)}`);
  } else if (pct > p.rangeMaxPct) {
    pct = p.rangeMaxPct;
    steps.push(`cut to max ${f1(pct)}`);
  }
  const cap = maxPctForBins(p.maxPositions * BIN_PER_POSITION, binStep);
  if (pct > cap) {
    pct = cap;
    steps.push(`capped by ${p.maxPositions} position(s) × ${BIN_PER_POSITION} bins @ bin step ${binStep} = ${f1(cap)}`);
  }
  if (pct < p.rangeMinPct) {
    steps.push(`min ${f1(p.rangeMinPct)} does not fit → skip`);
    return { pct: null, why: steps.join(" · ") };
  }
  return { pct, why: steps.join(" · ") };
}

// Lebar range (% turun dari harga) dibatasi min/max, lalu muat di maxPositions·70 bin; null jika min tak muat.
export function pickRangePct(bars, p, binStep) {
  return explainRangePct(bars, p, binStep).pct;
}
