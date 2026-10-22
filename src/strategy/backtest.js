// Replay backtest Auto Entry (murni, tanpa I/O): screener + sinyal + simulator per pool, lalu batas portofolio.
import { passesPoolFilters, passesTokenFilters, coversMinRange, volatilityPct, passesVolatility, toSolPerToken } from "./screen.js";
import { entrySignal, barsNeeded } from "./signal.js";
import { simulateTrade } from "./sim.js";
import { brakeHit } from "./limits.js";
import { periodStart } from "../lp/pnl-stats.js";

const BAR_MIN = 5;
const VOL_BARS = 6; // 30m = 6 bar 5m

// Screener pool pada bar i: volume/fee-TVL dari 6 bar terakhir, mcap diskalakan dengan harga.
export function historicalScreen(row, bars, i, p) {
  let volume30mUsd = 0;
  for (let k = Math.max(0, i - (VOL_BARS - 1)); k <= i; k++) volume30mUsd += bars[k].volume;
  const feeTvl30mPct = ((volume30mUsd * row.baseFeePct) / 100 / row.tvlUsd) * 100;
  const mcapUsd = (row.mcapUsd * bars[i].close) / bars[bars.length - 1].close;
  const vol = volatilityPct(bars.slice(Math.max(0, i + 1 - VOL_BARS), i + 1), VOL_BARS);
  const now = (bars[i].time + 300) * 1000;
  const ok =
    passesPoolFilters({ ...row, volume30mUsd, feeTvl30mPct, mcapUsd }, p, now).ok && passesVolatility(vol, p);
  return { ok, metrics: { volume30mUsd, feeTvl30mPct, volatilityPct: vol, mcapUsd, poolAgeH: (now - row.createdAt) / 3600000 } };
}

// Replay satu pool; trade tidak tumpang tindih, jeda cooldown (bar 5m) setelah bar exit.
export function replayPool({ row, token, bars: rawBars, p, g, solUsdAt }) {
  const bars = toSolPerToken(rawBars, row.baseIsX); // dataset tersimpan = orientasi mentah Meteora
  if (!passesTokenFilters(token, g).ok || !coversMinRange(row.binStep, p)) return [];
  const need = barsNeeded(p);
  const pool = { binStep: row.binStep, baseFeePct: row.baseFeePct, protocolFeePct: row.protocolFeePct, tvlUsd: row.tvlUsd };
  const trades = [];
  let i = need - 1;
  while (i < bars.length) {
    const screen = historicalScreen(row, bars, i, p);
    const sig = screen.ok ? entrySignal(bars.slice(Math.max(0, i + 1 - need), i + 1), p) : null;
    if (!sig?.enter) {
      i++;
      continue;
    }
    const r = simulateTrade({ bars, entryIndex: i + 1, p, pool, solUsdAt, sim: g.sim });
    if (!r) {
      i++;
      continue;
    }
    trades.push({ pool: row.address, mint: row.baseMint, profile: p.name, ...r, entryMetrics: { ...screen.metrics, ...sig.metrics } });
    const cooldownMin = r.pnlSol < 0 ? g.cooldownLossMin : g.cooldownMin;
    i = r.exitIndex + 1 + Math.ceil(cooldownMin / BAR_MIN);
  }
  return trades;
}

// Batas portofolio: maks p.maxOpen trade terbuka sekaligus dan rem rugi harian (hari WIB, berdasar entryTime).
export function portfolioPass(trades, p, g) {
  const accepted = [];
  const dayPnl = new Map();
  for (const t of [...trades].sort((a, b) => a.entryTime - b.entryTime)) {
    const open = accepted.filter((a) => a.entryTime <= t.entryTime && t.entryTime < a.exitTime).length;
    if (open >= p.maxOpen) continue;
    const day = periodStart("today", t.entryTime);
    if (brakeHit(dayPnl.get(day) ?? 0, g)) continue;
    accepted.push(t);
    dayPnl.set(day, (dayPnl.get(day) ?? 0) + t.pnlSol);
  }
  return { accepted, totals: summarize(accepted) };
}

// winRate dan flipRate berupa pecahan 0..1; maxDrawdownSol positif (turun dari puncak kumulatif PnL, urut exitTime).
function summarize(trades) {
  const n = trades.length;
  const exitMix = {};
  for (const t of trades) exitMix[t.exitReason] = (exitMix[t.exitReason] ?? 0) + 1;
  if (!n) return { trades: 0, winRate: 0, meanPct: 0, medianPct: 0, worst10Pct: 0, totalSol: 0, maxDrawdownSol: 0, avgHoldMin: 0, flipRate: 0, exitMix };
  const pcts = trades.map((t) => t.pnlPct).sort((a, b) => a - b);
  const mid = n >> 1;
  const worstN = Math.ceil(n * 0.1);
  let cum = 0;
  let peak = 0;
  let maxDrawdownSol = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    cum += t.pnlSol;
    peak = Math.max(peak, cum);
    maxDrawdownSol = Math.max(maxDrawdownSol, peak - cum);
  }
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  return {
    trades: n,
    winRate: trades.filter((t) => t.pnlSol > 0).length / n,
    meanPct: sum((t) => t.pnlPct) / n,
    medianPct: n % 2 ? pcts[mid] : (pcts[mid - 1] + pcts[mid]) / 2,
    worst10Pct: pcts.slice(0, worstN).reduce((s, v) => s + v, 0) / worstN, // rata-rata 10% terburuk
    totalSol: sum((t) => t.pnlSol),
    maxDrawdownSol,
    avgHoldMin: sum((t) => t.holdMin) / n,
    flipRate: trades.filter((t) => t.flipped).length / n,
    exitMix,
  };
}

// Ruang pencarian optimizer; trail/volatility berupa pasangan [a, b] yang dipecah jadi dua field.
export const SEARCH_SPACE = {
  common: {
    entryTiming: ["pullback", "immediate"],
    minPumpPct: [10, 15, 20, 30, 50],
    minPullbackPct: [3, 5, 8, 12],
    maxPullbackPct: [20, 30, 40],
    rangeMode: ["fixed", "support"],
    rangePct: [25, 35, 45, 55, 65],
    supportBufferPct: [0, 5, 10],
    flipPct: [40, 50, 60, 70, 80],
    tpPct: [0, 3, 5, 8, 10, 15, 20],
    slPct: [0, 10, 15, 20, 30],
    trail: [[0, 0], [5, 2], [5, 3], [10, 3]],
    oorAboveMin: [5, 10, 20, 30, 60],
    oorBelowMin: [5, 15, 30, 60, 120],
    minFeeTvl30mPct: [0.1, 0.2, 0.5, 1],
    volatility: [[1, 4], [2, 4], [2, 6], [3, 8], [0, 100]],
  },
  degen: { maxHoldMin: [60, 120, 240] },
  multihour: { maxHoldMin: [360, 720, 1440, 2880] },
};

const PAIR_FIELDS = { trail: ["trailStartPct", "trailDistancePct"], volatility: ["volatilityMinPct", "volatilityMaxPct"] };
export const MIN_TRADES = 20;
const TOP_TRAIN = 50;
const TOP_REPORT = 10;

// RNG ber-seed (hasil deterministik per --seed).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleParams(space, rng) {
  const out = {};
  for (const [key, options] of Object.entries(space)) {
    const pick = options[Math.floor(rng() * options.length)];
    if (PAIR_FIELDS[key]) PAIR_FIELDS[key].forEach((f, k) => (out[f] = pick[k]));
    else out[key] = pick;
  }
  return out;
}

// mean% - 0.5 * |rata-rata 10% terburuk|; -Infinity bila trade kurang dari minTrades.
export function scoreTrades(trades, { minTrades = MIN_TRADES } = {}) {
  if (trades.length < minTrades) return -Infinity;
  const { meanPct, worst10Pct } = summarize(trades);
  return meanPct - 0.5 * Math.abs(worst10Pct);
}

const byScoreDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

// Random search + walk-forward: train = bagian awal rentang waktu bar, validate = sisanya.
// results[].params = profil lengkap (baseP + sampel); train/validate = { score, ...totals }.
export function optimize({ dataset, barsByPool, baseP, g, solUsdAt, samples, seed, trainFrac = 0.7, minTrades = MIN_TRADES, space }) {
  const pools = [];
  let first = Infinity;
  let last = -Infinity;
  for (const { row, token } of dataset.pools) {
    const bars = barsByPool instanceof Map ? barsByPool.get(row.address) : barsByPool[row.address];
    if (!bars?.length) continue;
    pools.push({ row, token, bars });
    first = Math.min(first, bars[0].time);
    last = Math.max(last, bars[bars.length - 1].time);
  }
  if (!pools.length) return { cutoffSec: null, results: [] };
  const cutoffSec = first + trainFrac * (last - first);
  const sampleSpace = space ?? { ...SEARCH_SPACE.common, ...SEARCH_SPACE[baseP.name] };
  const rng = mulberry32(seed);
  const scored = [];
  for (let s = 0; s < samples; s++) {
    const params = { ...baseP, ...sampleParams(sampleSpace, rng) };
    const trades = pools.flatMap(({ row, token, bars }) => replayPool({ row, token, bars, p: params, g, solUsdAt }));
    const side = (list) => {
      const { accepted, totals } = portfolioPass(list, params, g);
      return { score: scoreTrades(accepted, { minTrades }), ...totals };
    };
    const train = side(trades.filter((t) => t.entryTime < cutoffSec * 1000));
    if (train.score === -Infinity) continue;
    scored.push({ params, train, validate: side(trades.filter((t) => t.entryTime >= cutoffSec * 1000)) });
  }
  const results = scored
    .sort((a, b) => byScoreDesc(a.train.score, b.train.score))
    .slice(0, TOP_TRAIN)
    .sort((a, b) => byScoreDesc(a.validate.score, b.validate.score) || byScoreDesc(a.train.score, b.train.score))
    .slice(0, TOP_REPORT);
  return { cutoffSec, results };
}
