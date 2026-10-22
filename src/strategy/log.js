// Log belajar strategi: satu baris JSON per trade auto yang selesai (live) atau paper trade yang tertutup.
// Trade live menyertakan prediksi PnL simulator di beberapa faktor kedalaman pool (untuk kalibrasi SIM_POOL_DEPTH_FACTOR).
import fs from "fs";
import config from "../config/index.js";
import log from "../core/logger.js";
import { STRATEGY_LOG_FILE } from "../core/paths.js";
import { listClosedTrades, markTradeStrategyLogged } from "../state/trades.js";
import { getPoolInfo } from "../entry/pool-info.js";
import { fetchOhlcvRange, getSolUsdForced } from "./sources.js";
import { toSolPerToken } from "./screen.js";
import { simulateTrade } from "./sim.js";

export const DEPTH_FACTORS = [0.25, 0.5, 1, 2, 4];
const SETTLE_WAIT_MS = 120_000; // beri waktu PnL final (reconcile) sebelum dicatat
const PNL_WAIT_MAX_MS = 30 * 60_000; // lewat ini, catat walau closePnlPct belum ada
const BAR_PAD_SEC = 300;

export function appendStrategyLog(row) {
  fs.appendFileSync(STRATEGY_LOG_FILE, `${JSON.stringify(row)}\n`);
}

// File tidak ada -> []; baris rusak dilewati.
export function readStrategyLog(file = STRATEGY_LOG_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row);
    } catch {
      /* baris rusak */
    }
  }
  return rows;
}

export function paperLogRow(t) {
  return {
    ts: t.closedAt,
    mode: "paper",
    profile: t.profile,
    pool: t.pool,
    pair: t.pair,
    mint: t.baseMint,
    params: t.p,
    entry: t.entry,
    pnlPct: t.closePnlPct,
    pnlSol: t.closePnlSol,
    holdMin: t.holdMin,
    flipped: t.flipped,
    exitReason: t.closeReason,
    predicted: null,
  };
}

function withDeps(deps = {}) {
  return {
    listClosedTrades,
    markLogged: markTradeStrategyLogged,
    getSolUsd: () => getSolUsdForced(),
    getBaseIsX: async (pool) => (await getPoolInfo(pool)).baseIsX,
    fetchOhlcvRange,
    append: appendStrategyLog,
    ...deps,
  };
}

// Prediksi PnL% simulator per faktor kedalaman untuk selama trade berjalan; null bila data tidak ada/gagal.
async function predictTrade(d, trade, solUsd) {
  try {
    if (!(solUsd > 0)) return null;
    const baseIsX = await d.getBaseIsX(trade.pool);
    const raw = await d.fetchOhlcvRange(trade.pool, Math.floor(trade.openedAt / 1000) - BAR_PAD_SEC, Math.ceil(trade.closedAt / 1000) + BAR_PAD_SEC);
    const bars = toSolPerToken(Array.isArray(raw) ? raw : [], baseIsX).filter((b) => b.time * 1000 >= trade.openedAt);
    if (bars.length === 0) return null;
    const { params, entry } = trade.strategy;
    const out = {};
    for (const factor of DEPTH_FACTORS) {
      const res = simulateTrade({
        bars,
        entryIndex: 0,
        p: params,
        pool: entry.poolMeta,
        solUsdAt: () => solUsd,
        sim: { ...config.autoEntry.sim, poolDepthFactor: factor },
        rangePct: entry.rangePct,
        stopAtSec: trade.closedAt / 1000,
      });
      if (!Number.isFinite(res?.pnlPct)) return null; // semua faktor atau tidak sama sekali
      out[factor] = res.pnlPct;
    }
    return out;
  } catch (err) {
    log.warn(`Strategy log ${trade.id}: prediksi gagal: ${err.message}`);
    return null;
  }
}

// Catat trade auto live yang sudah selesai; mengembalikan jumlah baris yang ditulis.
export async function logSettledAutoTrades({ deps, now } = {}) {
  const d = withDeps(deps);
  const t = now ?? Date.now();
  const due = d
    .listClosedTrades()
    .filter((x) => x.origin === "auto" && x.strategy && !x.strategyLogged && t - x.closedAt >= SETTLE_WAIT_MS)
    .filter((x) => Number.isFinite(x.closePnlPct) || t - x.closedAt >= PNL_WAIT_MAX_MS);
  if (due.length === 0) return 0;

  let solUsd = null;
  try {
    const v = Number(await d.getSolUsd());
    if (v > 0) solUsd = v;
  } catch (err) {
    log.warn(`Strategy log: harga SOL gagal: ${err.message}`);
  }

  let written = 0;
  for (const trade of due) {
    try {
      const predicted = await predictTrade(d, trade, solUsd);
      const pnlSol = solUsd && Number.isFinite(trade.closePnlUsd) ? trade.closePnlUsd / solUsd : null;
      d.append({
        ts: trade.closedAt,
        mode: "live",
        profile: trade.strategy.profile,
        pool: trade.pool,
        pair: trade.pair,
        mint: trade.baseMint,
        params: trade.strategy.params,
        entry: trade.strategy.entry,
        pnlPct: Number.isFinite(trade.closePnlPct) ? trade.closePnlPct : null,
        pnlSol,
        holdMin: (trade.closedAt - trade.openedAt) / 60000,
        flipped: trade.flipLegs?.length > 0,
        exitReason: trade.closeReason,
        predicted,
      });
      d.markLogged(trade.id);
      written++;
    } catch (err) {
      log.warn(`Strategy log ${trade.id}: gagal menulis: ${err.message}`);
    }
  }
  return written;
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function bucketStats(rows) {
  const pnl = rows.map((r) => r.pnlPct);
  return { trades: rows.length, winRate: (pnl.filter((x) => x > 0).length / rows.length) * 100, meanPct: mean(pnl) };
}

function bucketBy(rows, keyOf, labelOf) {
  const map = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!Number.isFinite(k)) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([k, list]) => ({ bucket: labelOf(k), ...bucketStats(list) }));
}

// Ringkasan: grup mode+profil, bucket rangePct (10 poin) / flipPct, dan faktor kedalaman dengan MAE terendah (hanya live).
export function summarizeRows(rows) {
  const valid = rows.filter((r) => Number.isFinite(r.pnlPct));
  const byGroup = new Map();
  for (const r of valid) {
    const k = `${r.mode}\u0000${r.profile}`;
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(r);
  }
  const groups = [...byGroup.values()].map((list) => {
    const pnl = list.map((r) => r.pnlPct);
    const holds = list.map((r) => r.holdMin).filter(Number.isFinite);
    const exitMix = {};
    for (const r of list) exitMix[r.exitReason ?? "?"] = (exitMix[r.exitReason ?? "?"] ?? 0) + 1;
    return {
      mode: list[0].mode,
      profile: list[0].profile,
      trades: list.length,
      winRate: (pnl.filter((x) => x > 0).length / list.length) * 100,
      meanPct: mean(pnl),
      medianPct: median(pnl),
      flipRate: (list.filter((r) => r.flipped === true).length / list.length) * 100,
      avgHoldMin: holds.length ? mean(holds) : null,
      exitMix,
    };
  });
  const buckets = {
    rangePct: bucketBy(valid, (r) => Math.floor(Number(r.params?.rangePct) / 10) * 10, (k) => `${k}-${k + 9}`),
    flipPct: bucketBy(valid, (r) => Number(r.params?.flipPct), (k) => String(k)),
  };

  const live = valid.filter((r) => r.mode === "live" && r.predicted && DEPTH_FACTORS.every((f) => Number.isFinite(r.predicted[f])));
  let calibration = null;
  for (const factor of DEPTH_FACTORS) {
    if (live.length === 0) break;
    const mae = mean(live.map((r) => Math.abs(r.predicted[factor] - r.pnlPct)));
    if (!calibration || mae < calibration.mae) calibration = { factor, mae, n: live.length };
  }
  return { groups, buckets, calibration };
}
