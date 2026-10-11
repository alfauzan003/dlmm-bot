import BN from "bn.js";

// Bagian strategi per shape. `mixed` = 70% BidAsk lalu 30% Spot di posisi yang sama.
export const SHAPE_PARTS = {
  spot: [{ strategy: "Spot", weight: 1 }],
  curve: [{ strategy: "Curve", weight: 1 }],
  bid_ask: [{ strategy: "BidAsk", weight: 1 }],
  mixed: [
    { strategy: "BidAsk", weight: 0.7 },
    { strategy: "Spot", weight: 0.3 },
  ],
};

const LAMPORTS = 1e9;

// Nilai (lamport) sisi token yang dibutuhkan range untuk 1 SOL di sisi SOL, menurut auto-fill SDK.
// `price` = activeBin.price = harga per lamport (raw Y per raw X), bukan harga UI.
export function tokenValuePerSol({ sdk, activeBin, binStep, lowerBin, upperBin, baseIsX, price, strategyType }) {
  const one = new BN(LAMPORTS);
  const zero = new BN(0);
  if (baseIsX) {
    const x1 = sdk.autoFillXByStrategy(activeBin, binStep, one, zero, zero, lowerBin, upperBin, strategyType);
    return Number(x1.toString()) * price;
  }
  const y1 = sdk.autoFillYByStrategy(activeBin, binStep, one, zero, zero, lowerBin, upperBin, strategyType);
  return Number(y1.toString()) / price;
}

// Bagi deposit per bagian: sisi SOL + nilai token yang dibeli = bagian deposit.
// SOL-only -> tanpa swap. Mengembalikan null bila hasil auto-fill tidak valid.
export function splitParts({ sdk, shape, solOnly, depositSol, ...range }) {
  const parts = [];
  for (const { strategy, weight } of SHAPE_PARTS[shape]) {
    const part = depositSol * weight;
    if (solOnly) {
      parts.push({ strategy, weight, solSideSol: part, swapSol: 0 });
      continue;
    }
    const v1 = tokenValuePerSol({ sdk, ...range, strategyType: sdk.StrategyType[strategy] });
    if (!Number.isFinite(v1) || v1 < 0) return null;
    const solSideSol = part / (1 + v1 / LAMPORTS);
    parts.push({ strategy, weight, solSideSol, swapSol: part - solSideSol });
  }
  return parts;
}

// Lebar posisi yang dibuat initializeMultiplePositionAndAddLiquidityByStrategy2 (SDK 1.9.14):
// 70 bin awal + MAX_RESIZE_LENGTH x (5 dengan ALT, 3 tanpa ALT).
export function parallelWidth(sdk, pool) {
  const withAlt = !!sdk.ALT_ADDRESS?.[pool?.opt?.cluster];
  return sdk.DEFAULT_BIN_PER_POSITION.toNumber() + sdk.MAX_RESIZE_LENGTH.toNumber() * (withAlt ? 5 : 3);
}

// Potong [lowerBin, upperBin] menjadi rentang berurutan selebar maksimum `width`.
export function chunkRange(lowerBin, upperBin, width) {
  const out = [];
  for (let lo = lowerBin; lo <= upperBin; lo += width)
    out.push({ lowerBin: lo, upperBin: Math.min(lo + width - 1, upperBin) });
  return out;
}

function overlap(lo, hi, a, b) {
  return Math.max(0, Math.min(hi, b) - Math.max(lo, a) + 1);
}

// Lapisan Spot (rata per bin) dipecah per posisi lalu per potongan <= maxBins bin.
// Token X ada di bin >= aktif, token Y di bin <= aktif; tiap potongan mendapat bagian
// sebanding jumlah bin X/Y yang dicakupnya.
export function spotPieces({ legs, activeBin, lowerBin, upperBin, totalX, totalY, maxBins }) {
  const xBins = overlap(lowerBin, upperBin, activeBin, Infinity);
  const yBins = overlap(lowerBin, upperBin, -Infinity, activeBin);
  const pieces = [];
  for (const leg of legs) {
    for (const c of chunkRange(leg.lowerBin, leg.upperBin, maxBins)) {
      const xb = overlap(c.lowerBin, c.upperBin, activeBin, Infinity);
      const yb = overlap(c.lowerBin, c.upperBin, -Infinity, activeBin);
      const x = xBins > 0 ? totalX.mul(new BN(xb)).div(new BN(xBins)) : new BN(0);
      const y = yBins > 0 ? totalY.mul(new BN(yb)).div(new BN(yBins)) : new BN(0);
      if (x.isZero() && y.isZero()) continue;
      pieces.push({ leg, lowerBin: c.lowerBin, upperBin: c.upperBin, x, y });
    }
  }
  return pieces;
}

// Mode exit per leg, sejalan dengan classifyMode: span >= SPOT_MIN_BINS -> spot.
export function legMode(span, solOnly, spotMinBins) {
  if (span >= spotMinBins) return "spot";
  return solOnly ? "bidask:sol" : "bidask:double";
}
