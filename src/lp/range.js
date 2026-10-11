// Preset range LP (persen di bawah/atas harga aktif) dan konversi persen -> bin DLMM.
export const RANGE_PRESETS = [
  { key: "narrow", label: "Narrow", below: 20, above: 20 },
  { key: "balanced", label: "Balanced", below: 45, above: 45 },
  { key: "wide", label: "Wide", below: 65, above: 65 },
  { key: "narrow_sol", label: "Narrow SOL", below: 20, above: 0 },
  { key: "balanced_sol", label: "Balanced SOL", below: 45, above: 0 },
  { key: "wide_sol", label: "Wide SOL", below: 65, above: 0 },
];

const NUMBER = /^\d+(\.\d+)?$/;

// "45" -> { below: 45, above: 0 }; "45 10" -> { below: 45, above: 10 }. Tidak valid -> null.
export function parseCustomRange(text) {
  const parts = String(text ?? "")
    .trim()
    .split(/\s+/);
  if (parts.length < 1 || parts.length > 2 || !parts.every((p) => NUMBER.test(p))) return null;
  const below = Number(parts[0]);
  const above = parts.length === 2 ? Number(parts[1]) : 0;
  if (!(below > 0 && below <= 99)) return null;
  if (!(above >= 0 && above <= 1000)) return null;
  return { below, above };
}

// Persen harga -> rentang bin. Harga bin = f^id dengan f = 1 + binStep/10000.
export function pctToBinRange({ activeBin, binStep, below, above, baseIsX }) {
  const lnF = Math.log(1 + binStep / 10000);
  const binsBelow = Math.floor(Math.log(1 - below / 100) / -lnF);
  const binsAbove = Math.floor(Math.log(1 + above / 100) / lnF);
  const lowerBin = baseIsX ? activeBin - binsBelow : activeBin - binsAbove;
  const upperBin = baseIsX ? activeBin + binsAbove : activeBin + binsBelow;
  return { lowerBin, upperBin, binCount: upperBin - lowerBin + 1, solOnly: above === 0 };
}

// Harga token dalam SOL di kedua ujung range (dibalik bila SOL adalah token X).
export function binPriceBounds({ lowerBin, upperBin, binStep, baseIsX, decimalsBase, decimalsSol }) {
  const f = 1 + binStep / 10000;
  if (baseIsX) {
    const scale = 10 ** (decimalsBase - decimalsSol);
    return { lowSol: f ** lowerBin * scale, highSol: f ** upperBin * scale };
  }
  const scale = 10 ** (decimalsSol - decimalsBase);
  return { lowSol: 1 / (f ** upperBin * scale), highSol: 1 / (f ** lowerBin * scale) };
}
