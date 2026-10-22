// Evaluator exit Auto Entry (murni, tanpa I/O). Waktu = epoch ms, menit dari profil p.
export const STRATEGY_EXIT_REASONS = ["cycle_done", "pumped_away", "range_broken", "volume_died", "max_hold"];

// Posisi harga token: makin besar = token makin mahal (xIsSol membalik arah bin).
export function tokenPos(bin, xIsSol) {
  return xIsSol ? -bin : bin;
}

const MIN_MS = 60_000;

export function evaluateStrategyExit({ trade, view, p, now }) {
  const { xIsSol } = view;
  const pos = tokenPos(view.activeBin, xIsSol);
  const { lowerBin, upperBin } = trade.range;
  const rangeTop = Math.max(tokenPos(lowerBin, xIsSol), tokenPos(upperBin, xIsSol));
  const rangeBottom = Math.min(tokenPos(lowerBin, xIsSol), tokenPos(upperBin, xIsSol));
  const flipped = (trade.flipLegs?.length ?? 0) > 0;
  const prev = trade.strategyState ?? {};

  const above = !flipped && pos > rangeTop;
  const below = pos < rangeBottom;
  const aboveSince = above ? (prev.aboveSince ?? now) : null;
  const belowSince = below ? (prev.belowSince ?? now) : null;
  const state = { aboveSince, belowSince };
  const done = (reason) => ({ reason, state });

  if (flipped && view.flipLegs.length > 0) {
    const legsTop = Math.max(...view.flipLegs.flatMap((l) => [tokenPos(l.lowerBin, xIsSol), tokenPos(l.upperBin, xIsSol)]));
    if (pos > legsTop) return done("cycle_done");
  }
  if (p.oorAboveMin > 0 && above && now - aboveSince >= p.oorAboveMin * MIN_MS) return done("pumped_away");
  if (p.oorBelowMin > 0 && below && now - belowSince >= p.oorBelowMin * MIN_MS) return done("range_broken");
  if (p.lowVolumeBars > 0 && p.minVolume5mUsd > 0 && view.volumes.length >= p.lowVolumeBars
    && view.volumes.slice(-p.lowVolumeBars).every((v) => v < p.minVolume5mUsd)) return done("volume_died");
  if (p.maxHoldMin > 0 && now - trade.openedAt >= p.maxHoldMin * MIN_MS) return done("max_hold");
  return done(null);
}

const mins = (ms) => `${Math.round(ms / MIN_MS)}m`;
const usd = (v) => `$${Math.round(Number(v) || 0)}`;

// Penjelasan singkat (untuk log / alert) kenapa evaluateStrategyExit memberi `reason`; state = hasilnya.
export function strategyExitDetail(reason, { trade, view, p, now, state }) {
  if (reason === "cycle_done") return "price rose above the flip range — tokens sold back to SOL";
  if (reason === "pumped_away")
    return `price above range (no dip, SOL unused) for ${mins(now - state.aboveSince)} ≥ ${p.oorAboveMin}m`;
  if (reason === "range_broken") return `price below range for ${mins(now - state.belowSince)} ≥ ${p.oorBelowMin}m`;
  if (reason === "volume_died") {
    const vols = view.volumes.slice(-p.lowVolumeBars).map(usd).join(" / ");
    return `last ${p.lowVolumeBars} 5m bars ${vols} < ${usd(p.minVolume5mUsd)}`;
  }
  if (reason === "max_hold") return `held ${mins(now - trade.openedAt)} ≥ ${p.maxHoldMin}m`;
  return null;
}
