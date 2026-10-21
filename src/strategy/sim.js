// Simulator posisi BidAsk single-sided SOL (murni, tanpa I/O). Harga = SOL per token, bin k relatif terhadap bin entry (k=0, harga p0).
import { binsForPct } from "./screen.js";

const ratio = (binStep) => 1 + binStep / 1e4;
const priceOf = (pos, k) => pos.p0 * ratio(pos.binStep) ** k;

// BidAsk linear: indeks 0 = bin terdekat harga, bobot naik menjauh.
export function bidAskWeights(count) {
  const sum = (count * (count + 1)) / 2;
  return Array.from({ length: count }, (_, i) => (i + 1) / sum);
}

// Urutan harga dalam satu bar: bar merah lewat high dulu, bar hijau lewat low dulu.
export function barPath(bar) {
  const { open, high, low, close } = bar;
  return close < open ? [open, high, low, close] : [open, low, high, close];
}

export function binOf(price, p0, binStep) {
  return Math.round(Math.log(price / p0) / Math.log(ratio(binStep)));
}

export function createSimPosition({ depositSol, rangePct, binStep, p0 }) {
  const n = binsForPct(rangePct, binStep) + 1;
  const w = bidAskWeights(n);
  const bins = new Map();
  for (let i = 0; i < n; i++) bins.set(-i, { sol: depositSol * w[i], token: 0 });
  return { binStep, p0, n, bins, active: 0, flip: null, feesSol: 0 };
}

// Pindah bin aktif: turun -> SOL jadi token di harga bin; naik -> token jadi SOL. Bin di luar posisi diabaikan.
export function moveActive(pos, toK) {
  const a = pos.active;
  if (toK < a) {
    for (let k = a; k > toK; k--) {
      const b = pos.bins.get(k);
      if (!b) continue;
      b.token += b.sol / priceOf(pos, k);
      b.sol = 0;
    }
  } else if (toK > a) {
    for (let k = a; k < toK; k++) {
      const b = pos.bins.get(k);
      if (!b) continue;
      b.sol += b.token * priceOf(pos, k);
      b.token = 0;
    }
  }
  pos.active = toK;
}

// Fee: volume dibagi rata ke tiap kunjungan bin, porsi kita = our / (our + likuiditas pool).
export function accrueFees(pos, { visits, volumeSol, lpFeeRate, poolLiqSolAt }) {
  if (!visits.length) return 0;
  const perVisit = volumeSol / visits.length;
  let added = 0;
  for (const k of visits) {
    const b = pos.bins.get(k);
    if (!b) continue;
    const our = b.sol + b.token * priceOf(pos, k);
    const total = our + poolLiqSolAt(k);
    if (!(total > 0)) continue;
    added += perVisit * lpFeeRate * (our / total);
  }
  pos.feesSol += added;
  return added;
}

export function pathVisits(fromK, toK) {
  const out = [];
  const step = toK >= fromK ? 1 : -1;
  for (let k = fromK; k !== toK + step; k += step) out.push(k);
  return out;
}

// Nilai posisi dalam SOL pada harga tertentu (fee tidak termasuk).
export function positionValueSol(pos, price) {
  let v = 0;
  for (const b of pos.bins.values()) v += b.sol + b.token * price;
  return v;
}
