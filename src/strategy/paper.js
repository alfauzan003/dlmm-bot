// Paper trade Auto Entry (DRY_RUN): data pool nyata saat entry, lalu dimajukan lewat simulator di candle 5m live.
// Disimpan di PAPER_FILE (bukan state.json). Semua I/O lewat deps agar tes tidak menyentuh jaringan.
import fs from "fs";
import config from "../config/index.js";
import log from "../core/logger.js";
import { PAPER_FILE } from "../core/paths.js";
import { WSOL_MINT } from "../core/constants.js";
import { readJsonArray } from "../state/store.js";
import { getPoolInfo } from "../entry/pool-info.js";
import { getMintDecimals } from "../solana/balances.js";
import { fetchCandles } from "../market/candles.js";
import { getPrice } from "../market/jupiter-price.js";
import * as tg from "../notify/telegram.js";
import { pctToBinRange } from "../lp/range.js";
import { closedBars } from "./screen.js";
import { simulateTrade } from "./sim.js";

const BAR_SEC = 300;

function withDeps(deps = {}) {
  return {
    getPoolInfo,
    getMintDecimals,
    fetchCandles,
    getSolUsd: () => getPrice(WSOL_MINT),
    notifyEntry: tg.notifyAutoEntry,
    notifyClose: tg.notifyPaperClose,
    log: () => {}, // Task 17: appendStrategyLog
    now: Date.now,
    ...deps,
  };
}

const read = () => readJsonArray(PAPER_FILE);
const write = (list) => fs.writeFileSync(PAPER_FILE, JSON.stringify(list, null, 2));

// open: true = hanya terbuka, false = hanya tertutup, kosong = semua.
export function listPaperTrades({ open } = {}) {
  const all = read();
  if (open === true) return all.filter((t) => t.closed !== true);
  if (open === false) return all.filter((t) => t.closed === true);
  return all;
}

const num = (v) => Number(v?.toString?.() ?? v);

// Likuiditas pool per bin relatif k (k=0 bin aktif, k<0 di bawah harga token) dalam SOL. Gagal -> {}.
async function readPoolLiq(d, row, rangePct) {
  try {
    const info = await d.getPoolInfo(row.address);
    const { pool } = info;
    const baseIsX = row.baseIsX ?? info.baseIsX;
    const activeId = (await pool.getActiveBin()).binId;
    const { lowerBin, upperBin } = pctToBinRange({ activeBin: activeId, binStep: row.binStep, below: rangePct, above: 0, baseIsX });
    const { bins } = await pool.getBinsBetweenLowerAndUpperBound(lowerBin, upperBin);
    const decimals = await d.getMintDecimals(row.baseMint);
    const out = {};
    for (const b of bins) {
      const x = num(b.xAmount);
      const y = num(b.yAmount);
      const pp = Number(b.pricePerToken); // tokenY per tokenX (sudah disesuaikan desimal)
      if (!(pp > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const sol = baseIsX ? y / 1e9 + (x / 10 ** decimals) * pp : x / 1e9 + (y / 10 ** decimals) / pp;
      if (!Number.isFinite(sol)) continue;
      out[baseIsX ? b.binId - activeId : activeId - b.binId] = sol;
    }
    return out;
  } catch (err) {
    log.warn(`Paper: likuiditas pool ${row.address.slice(0, 8)} gagal dibaca: ${err.message} — pakai estimasi TVL`);
    return {};
  }
}

export async function openPaperTrade({ profile, p, row, rangePct, entry, deps }) {
  const d = withDeps(deps);
  const openedAt = d.now();
  const poolLiq = await readPoolLiq(d, row, rangePct);
  const pair = row.name || `${row.baseMint.slice(0, 4)}-SOL`;
  // Baca-tulis sinkron: id unik walau scan dan tick berjalan bergantian.
  const list = read();
  const n = list.reduce((m, t) => Math.max(m, Number(String(t.id).slice(1)) || 0), 0) + 1;
  const trade = {
    id: `P${n}`,
    profile,
    pool: row.address,
    pair,
    baseMint: row.baseMint,
    openedAt,
    entryBarTime: Math.floor(openedAt / (BAR_SEC * 1000)) * BAR_SEC + BAR_SEC,
    p: { ...p }, // snapshot parameter profil saat entry (seperti trade.strategy.params)
    rangePct,
    poolMeta: {
      binStep: row.binStep,
      baseFeePct: row.baseFeePct,
      protocolFeePct: row.protocolFeePct,
      tvlUsd: row.tvlUsd,
    },
    poolLiq,
    entry: { metrics: entry?.metrics ?? null, signal: entry?.signal ?? null },
    closed: false,
    closedAt: null,
    closeReason: null,
    closePnlSol: null,
    closePnlPct: null,
    flipped: false,
    holdMin: null,
  };
  list.push(trade);
  write(list);
  try {
    d.notifyEntry({
      profile,
      pair,
      pool: row.address,
      sizeSol: p.sizeSol,
      rangePct,
      binStep: row.binStep,
      baseFeePct: row.baseFeePct,
      feeTvl30mPct: entry?.metrics?.feeTvl30mPct,
      volatilityPct: entry?.metrics?.volatilityPct,
      mcapUsd: entry?.metrics?.mcapUsd,
      paper: true,
    });
  } catch (err) {
    log.warn(`Paper: alert entry gagal: ${err.message}`);
  }
  log.info(`[PAPER] open ${pair} (${profile}) −${rangePct.toFixed(0)}% — ${trade.id}`);
  return trade;
}

export function paperLogRow(t) {
  return {
    kind: "paper_close",
    id: t.id,
    profile: t.profile,
    pool: t.pool,
    pair: t.pair,
    baseMint: t.baseMint,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    closeReason: t.closeReason,
    closePnlSol: t.closePnlSol,
    closePnlPct: t.closePnlPct,
    holdMin: t.holdMin,
    flipped: t.flipped,
    rangePct: t.rangePct,
    entry: t.entry,
  };
}

// Majukan semua paper trade terbuka dengan candle 5m tertutup; mengembalikan yang ditutup tick ini.
export async function tickPaperTrades({ deps, now } = {}) {
  const d = withDeps(deps);
  const open = listPaperTrades({ open: true });
  if (open.length === 0) return [];
  const t = now ?? d.now();
  const g = config.autoEntry;

  let solUsd;
  try {
    solUsd = Number(await d.getSolUsd());
  } catch (err) {
    log.warn(`Paper: harga SOL gagal: ${err.message} — tick dilewati`);
    return [];
  }
  if (!(solUsd > 0)) return [];

  const closed = [];
  for (const trade of open) {
    try {
      const limit = Math.max(0, Math.ceil((t / 1000 - trade.entryBarTime) / BAR_SEC)) + 2;
      const candles = await d.fetchCandles(trade.baseMint, trade.pool, { resolution: "5m", limit });
      const bars = closedBars(Array.isArray(candles) ? candles : [], t)
        .filter((b) => b.time >= trade.entryBarTime)
        .sort((a, b) => a.time - b.time);
      if (bars.length === 0) continue;
      const m = trade.poolMeta;
      const fallback = ((m.tvlUsd / solUsd) * g.sim.poolDepthFactor) / g.sim.poolSpreadBins;
      const res = simulateTrade({
        bars,
        entryIndex: 0,
        p: trade.p,
        pool: m,
        rangePct: trade.rangePct,
        solUsdAt: () => solUsd,
        sim: g.sim,
        poolLiqSolAt: (k) => trade.poolLiq?.[k] ?? fallback,
      });
      if (!res || res.exitReason == null || res.exitReason === "end_of_data") continue;

      // Baca ulang sebelum tulis: scan bisa menambah trade selama await di atas.
      const list = read();
      const cur = list.find((x) => x.id === trade.id);
      if (!cur || cur.closed === true) continue;
      Object.assign(cur, {
        closed: true,
        closedAt: res.exitTime,
        closeReason: res.exitReason,
        closePnlSol: res.pnlSol,
        closePnlPct: res.pnlPct,
        flipped: res.flipped,
        holdMin: res.holdMin,
      });
      write(list);
      closed.push(cur);
      log.info(`[PAPER] close ${cur.pair} (${cur.profile}) ${cur.closeReason} ${cur.closePnlPct.toFixed(2)}% — ${cur.id}`);
      try {
        d.notifyClose(cur);
      } catch (err) {
        log.warn(`Paper: alert close gagal: ${err.message}`);
      }
      try {
        d.log(paperLogRow(cur));
      } catch (err) {
        log.warn(`Paper: log close gagal: ${err.message}`);
      }
    } catch (err) {
      log.warn(`Paper ${trade.id}: tick gagal: ${err.message}`);
    }
  }
  return closed;
}
