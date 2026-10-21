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
  if (above && now - aboveSince >= p.oorAboveMin * MIN_MS) return done("pumped_away");
  if (below && now - belowSince >= p.oorBelowMin * MIN_MS) return done("range_broken");
  if (p.lowVolumeBars > 0 && p.minVolume5mUsd > 0 && view.volumes.length >= p.lowVolumeBars
    && view.volumes.slice(-p.lowVolumeBars).every((v) => v < p.minVolume5mUsd)) return done("volume_died");
  if (p.maxHoldMin > 0 && now - trade.openedAt >= p.maxHoldMin * MIN_MS) return done("max_hold");
  return done(null);
}
