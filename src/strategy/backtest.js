// Replay backtest Auto Entry (murni, tanpa I/O): screener + sinyal + simulator per pool, lalu batas portofolio.
import { passesPoolFilters, passesTokenFilters, coversMinRange, volatilityPct, passesVolatility } from "./screen.js";
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
export function replayPool({ row, token, bars, p, g, solUsdAt }) {
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
