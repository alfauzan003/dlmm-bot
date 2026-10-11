// Flip trade bid_ask/mixed: tarik bin yang sudah sepenuhnya token (sisi token dari bin aktif),
// lalu setor ulang token itu sebagai posisi BidAsk satu-sisi (cermin lebar) di atas harga.

export const FLIP_MAX_BINS = 70;
export const FLIP_SHAPES = ["bid_ask", "mixed"];

export function canFlip(trade) {
  return FLIP_SHAPES.includes(trade?.shape);
}

// Pilih bin yang ditarik: hanya bin sisi token (bin aktif tidak ikut) yang berisi token,
// maksimum `maxBins` terdekat ke bin aktif dari semua leg. Satu rentang per leg.
export function selectFlipBins({ legs, activeBinId, baseIsX, maxBins = FLIP_MAX_BINS }) {
  const tokenSide = (binId) => (baseIsX ? binId > activeBinId : binId < activeBinId);
  const picked = [];
  for (const leg of legs || []) {
    for (const b of leg.bins || []) {
      if (tokenSide(b.binId) && b.tokenAmount > 0) picked.push({ position: leg.position, binId: b.binId });
    }
  }
  picked.sort((a, b) => Math.abs(a.binId - activeBinId) - Math.abs(b.binId - activeBinId));
  const chosen = picked.slice(0, maxBins);

  const byLeg = new Map();
  for (const { position, binId } of chosen) {
    const r = byLeg.get(position);
    if (!r) byLeg.set(position, { position, fromBinId: binId, toBinId: binId });
    else {
      r.fromBinId = Math.min(r.fromBinId, binId);
      r.toBinId = Math.max(r.toBinId, binId);
    }
  }
  // Urutan leg mengikuti input.
  const out = (legs || []).map((l) => byLeg.get(l.position)).filter(Boolean);
  return { binCount: chosen.length, legs: out };
}

// Rentang posisi baru: n bin di sisi token, tanpa bin aktif.
export function flipRange(activeBinId, n, baseIsX) {
  return baseIsX
    ? { minBinId: activeBinId + 1, maxBinId: activeBinId + n }
    : { minBinId: activeBinId - n, maxBinId: activeBinId - 1 };
}
