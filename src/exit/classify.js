import config from "../config/index.js";

// Ambang dust untuk deposit awal (UI units).
const ENTRY_DUST_SOL = 1e-4;
const ENTRY_DUST_BASE = 1e-6;

// Mode composite yang dikenal. Nilai lama (mis. angka 0/1) dianggap invalid
// dan harus direklasifikasi ulang dari data posisi.
export const COMPOSITE_MODES = new Set(["bidask:double", "bidask:token", "bidask:sol", "spot"]);

export function isCompositeMode(mode) {
  return typeof mode === "string" && COMPOSITE_MODES.has(mode);
}

// Mode composite `<strategi>:<komposisi>`.
// Spot-quote: span >= SPOT_MIN_BINS, satu mode tanpa komposisi.
// Selain itu: bidask, komposisi dari deposit awal (allTimeDeposits) bila ada,
// fallback ke isi bin saat ini.
export function classifyMode(pos) {
  const { hasX, hasY, binSpan, xIsSol } = pos;
  const baseIsX = !xIsSol;

  if (Number.isFinite(binSpan) && binSpan >= config.spotMinBins) {
    return "spot";
  }

  let composition = null;
  const entryBase = pos.entryBaseAmount;
  const entrySol = pos.entrySolAmount;
  if (Number.isFinite(entryBase) && Number.isFinite(entrySol) && (entryBase > 0 || entrySol > 0)) {
    const hasBaseDep = entryBase > ENTRY_DUST_BASE;
    const hasSolDep = entrySol > ENTRY_DUST_SOL;
    if (hasBaseDep && !hasSolDep) composition = "token";
    else if (hasSolDep && !hasBaseDep) composition = "sol";
    else composition = "double";
  }

  if (!composition) {
    const hasBase = baseIsX ? hasX : hasY;
    const hasQuote = baseIsX ? hasY : hasX;
    if (hasBase && !hasQuote) composition = "token";
    else if (hasQuote && !hasBase) composition = "sol";
    else composition = "double";
  }

  return `bidask:${composition}`;
}
