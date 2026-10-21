// Simulator posisi BidAsk single-sided SOL (murni, tanpa I/O). Harga = SOL per token, bin k relatif terhadap bin entry (k=0, harga p0).
import { BIN_PER_POSITION, binsForPct } from "./screen.js";
import { pickRangePct } from "./signal.js";
import { evaluateStrategyExit } from "./exits.js";
import { profileExit } from "./params.js";
import { evaluateTradeExit } from "../exit/trade-exit.js";

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

// Flip: tarik token dari bin di atas harga (70 terdekat), deposit ulang token-only BidAsk di atas harga.
export function flipSimPosition(pos) {
  const ks = [...pos.bins.keys()]
    .filter((k) => k > pos.active && pos.bins.get(k).token > 0)
    .sort((a, b) => a - b)
    .slice(0, BIN_PER_POSITION);
  let tokenAmount = 0;
  for (const k of ks) {
    const b = pos.bins.get(k);
    tokenAmount += b.token;
    b.token = 0;
  }
  const binCount = ks.length;
  const w = bidAskWeights(binCount);
  for (let i = 0; i < binCount; i++) {
    const k = pos.active + 1 + i;
    const b = pos.bins.get(k) ?? { sol: 0, token: 0 };
    b.token += tokenAmount * w[i];
    pos.bins.set(k, b);
  }
  if (binCount > 0) pos.flip = { lo: pos.active + 1, hi: pos.active + binCount };
  return { binCount, tokenAmount };
}

const POINT_SEC = 75; // 4 titik path per bar 5m

// Satu trade BidAsk SOL-only: open di open bar entry -> flip -> exit -> close. Waktu hasil = epoch ms.
export function simulateTrade({ bars, entryIndex, p, pool, solUsdAt, sim, poolLiqSolAt, stopAtSec, rangePct }) {
  const entry = bars[entryIndex];
  if (!entry) return null;
  const pct = rangePct ?? pickRangePct(bars.slice(0, entryIndex), p, pool.binStep);
  if (pct == null) return null;
  const deposit = p.sizeSol;
  const pos = createSimPosition({ depositSol: deposit, rangePct: pct, binStep: pool.binStep, p0: entry.open });
  const positions = Math.ceil(pos.n / BIN_PER_POSITION);
  const lpFeeRate = (pool.baseFeePct / 100) * (1 - pool.protocolFeePct / 100);
  const entryTime = entry.time * 1000;
  const trade = {
    range: { lowerBin: -(pos.n - 1), upperBin: 0 },
    flipLegs: [],
    openedAt: entryTime,
    strategyState: null,
    exit: profileExit(p),
    peakPnlPct: null,
    trailArmed: false,
  };
  let flipped = false;

  const finish = (price, exitReason, exitIndex, exitTime) => {
    let sol = 0;
    let token = 0;
    for (const b of pos.bins.values()) {
      sol += b.sol;
      token += b.token;
    }
    const txCount = 2 * positions + (flipped ? 3 : 0);
    const value =
      sol +
      token * price * (1 - sim.swapCostPct / 100) +
      pos.feesSol * (1 - sim.swapCostPct / 200) -
      sim.txCostSol * txCount;
    const pnlSol = value - deposit;
    return {
      pnlPct: (pnlSol / deposit) * 100,
      pnlSol,
      feesSol: pos.feesSol,
      holdMin: (exitTime - entryTime) / 60000,
      flipped,
      exitReason,
      exitIndex,
      entryTime,
      exitTime,
    };
  };

  for (let i = entryIndex; i < bars.length; i++) {
    const bar = bars[i];
    const solUsd = solUsdAt(bar.time);
    const liqAt = poolLiqSolAt ?? (() => ((pool.tvlUsd / solUsd) * sim.poolDepthFactor) / sim.poolSpreadBins);
    const volumeSol = bar.volume / solUsd;
    const path = barPath(bar);
    const ks = path.map((px) => binOf(px, pos.p0, pos.binStep));
    // Total kunjungan bin sepanjang bar, untuk membagi volume bila trade tutup di tengah bar.
    let totalVisits = 1;
    for (let j = 0, from = pos.active; j < ks.length; from = ks[j++]) totalVisits += Math.abs(ks[j] - from);
    let visits = [pos.active];
    // Fee untuk kunjungan sejauh ini, volume diskalakan dengan porsi kunjungan bar.
    const accrue = () => {
      accrueFees(pos, { visits, volumeSol: (volumeSol * visits.length) / totalVisits, lpFeeRate, poolLiqSolAt: liqAt });
      visits = [];
    };
    const volumes = p.lowVolumeBars > 0 ? bars.slice(Math.max(0, i - p.lowVolumeBars), i).map((b) => b.volume) : [];
    const view = { activeBin: 0, xIsSol: false, flipLegs: [], volumes };

    for (let j = 0; j < path.length; j++) {
      const price = path[j];
      const t = bar.time + POINT_SEC * j;
      const last = j === path.length - 1;
      visits.push(...pathVisits(pos.active, ks[j]).slice(1));
      moveActive(pos, ks[j]);
      if (!flipped && pos.n > 1 && (-pos.active / (pos.n - 1)) * 100 >= p.flipPct) {
        accrue(); // kunjungan sebelum flip dihitung dengan distribusi lama
        if (flipSimPosition(pos).binCount > 0) {
          flipped = true;
          trade.flipLegs = ["sim"];
        }
      }
      if (last) accrue(); // fee bar masuk sebelum cek exit di titik terakhir
      const costs = sim.txCostSol * (positions + (flipped ? 2 : 0));
      const pnlPct = ((positionValueSol(pos, price) + pos.feesSol - costs - deposit) / deposit) * 100;
      const te = evaluateTradeExit(trade, pnlPct);
      trade.peakPnlPct = te.peakPnlPct;
      trade.trailArmed = te.trailArmed;
      view.activeBin = pos.active;
      view.flipLegs = pos.flip ? [{ lowerBin: pos.flip.lo, upperBin: pos.flip.hi }] : [];
      const se = evaluateStrategyExit({ trade, view, p, now: t * 1000 });
      trade.strategyState = se.state;

      let reason = te.reason ?? se.reason;
      if (!reason && stopAtSec != null && t >= stopAtSec) reason = "stop";
      if (!reason && last && i === bars.length - 1) reason = "end_of_data";
      if (reason && !last) accrue(); // tutup di tengah bar: hanya porsi kunjungan sejauh ini
      if (reason) return finish(price, reason, i, t * 1000);
    }
  }
  return null;
}
