// Ambang dust untuk deposit awal (UI units).
const ENTRY_DUST_SOL = 1e-4;
const ENTRY_DUST_BASE = 1e-6;

// Mode composite yang dikenal. Nilai lama (mis. angka 0/1) dianggap invalid
// dan harus direklasifikasi ulang dari data posisi.
export const COMPOSITE_MODES = new Set(["bidask:double", "bidask:token", "bidask:sol", "spot"]);

export function isCompositeMode(mode) {
  return typeof mode === "string" && COMPOSITE_MODES.has(mode);
}

// Spot = likuiditas rata per bin (SDK: base tanpa delta di kedua sisi), berapa pun jumlah bin-nya.
// BidAsk/Curve/mixed menanjak atau menurun dari bin aktif. Likuiditas bin DLMM (P·x + y) tidak
// berubah oleh swap, jadi pola ini tetap terbaca setelah harga bergerak.
const SPOT_MIN_DETECT_BINS = 3;
const SPOT_TOLERANCE = 0.1;
const SPOT_MIN_SHARE = 0.8;

export function isSpotDistribution(binData) {
  const liq = (binData || []).map((b) => Number(b?.positionLiquidity ?? 0)).filter((v) => v > 0);
  if (liq.length < SPOT_MIN_DETECT_BINS) return false;
  const sorted = [...liq].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // Toleransi untuk bin aktif (isi sebagian) dan pembulatan.
  const near = liq.filter((v) => Math.abs(v - median) <= median * SPOT_TOLERANCE).length;
  return near / liq.length >= SPOT_MIN_SHARE;
}

// Mode composite `<strategi>:<komposisi>`.
// Spot: distribusi likuiditas rata (pos.spotDistribution), satu mode tanpa komposisi.
// Selain itu: bidask, komposisi dari deposit awal (allTimeDeposits) bila ada,
// fallback ke isi bin saat ini.
export function classifyMode(pos) {
  const { hasX, hasY, xIsSol } = pos;
  const baseIsX = !xIsSol;

  if (pos.spotDistribution === true) {
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
