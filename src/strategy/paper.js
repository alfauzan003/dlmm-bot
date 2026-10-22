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
import { poolPriceSolPerToken } from "../entry/price-guard.js";
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

// Ubah satu trade (baca-tulis sinkron); null bila id tidak ada.
function patchTrade(id, patch) {
  const list = read();
  const cur = list.find((x) => x.id === id);
  if (!cur) return null;
  Object.assign(cur, patch);
  write(list);
  return cur;
}

const warned = new Set(); // id trade yang sudah diperingatkan (data buruk), sekali per trade
function warnOnce(id, msg) {
  if (warned.has(id)) return;
  warned.add(id);
  log.warn(`Paper ${id}: ${msg} — tick dilewati`);
}

// open: true = hanya terbuka, false = hanya tertutup, kosong = semua.
export function listPaperTrades({ open } = {}) {
  const all = read();
  if (open === true) return all.filter((t) => t.closed !== true);
  if (open === false) return all.filter((t) => t.closed === true);
  return all;
}

const num = (v) => Number(v?.toString?.() ?? v);

// Data pool saat entry: likuiditas per bin relatif k (k=0 bin aktif, k<0 di bawah harga token) dalam SOL,
// dan harga bin aktif (SOL per token). Gagal -> {} / null (sim memakai estimasi TVL).
async function readPoolLiq(d, row, rangePct) {
  let entryPrice = null;
  try {
    const info = await d.getPoolInfo(row.address);
    const { pool } = info;
    const baseIsX = row.baseIsX ?? info.baseIsX;
    const active = await pool.getActiveBin();
    const activeId = active.binId;
    entryPrice = poolPriceSolPerToken(active, baseIsX);
    const { lowerBin, upperBin } = pctToBinRange({ activeBin: activeId, binStep: row.binStep, below: rangePct, above: 0, baseIsX });
    const { bins } = await pool.getBinsBetweenLowerAndUpperBound(lowerBin, upperBin);
    // Desimal dari objek pool; getMintDecimals mengembalikan 9 saat RPC error, jadi hanya cadangan.
    const poolDec = (baseIsX ? pool.tokenX : pool.tokenY)?.mint?.decimals;
    const decimals = Number.isInteger(poolDec) ? poolDec : await d.getMintDecimals(row.baseMint);
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
    return { poolLiq: out, entryPrice };
  } catch (err) {
    log.warn(`Paper: likuiditas pool ${row.address.slice(0, 8)} gagal dibaca: ${err.message} — pakai estimasi TVL`);
    return { poolLiq: {}, entryPrice };
  }
}

export async function openPaperTrade({ profile, p, row, rangePct, entry, deps }) {
  const d = withDeps(deps);
  const openedAt = d.now();
  const { poolLiq, entryPrice } = await readPoolLiq(d, row, rangePct);
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
    entryPrice, // harga bin aktif saat entry (SOL per token); cadangan bila bar entry tak pernah muncul
    entry: { metrics: entry?.metrics ?? null, signal: entry?.signal ?? null },
    closed: false,
    closedAt: null,
    closeReason: null,
    closePnlSol: null,
    closePnlPct: null,
    flipped: false,
    holdMin: null,
    bars: [], // candle 5m tertutup sejak entryBarTime (riwayat milik trade ini)
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

// Gabung bar baru ke riwayat (per time; bar baru menimpa), urut naik, hanya time >= entryBarTime.
function mergeBars(stored, fresh, entryBarTime) {
  const byTime = new Map();
  for (const b of [...stored, ...fresh]) if (b.time >= entryBarTime) byTime.set(b.time, b);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// Seri untuk simulasi: slot 5m yang hilang diisi bar datar di close sebelumnya, volume 0.
// Slot awal (dari entryBarTime sampai bar nyata pertama) diisi datar di entryPrice bila valid dan slot sudah
// tertutup (nowSec); tanpa entryPrice -> null (tunggu bar entry).
export function fillGaps(bars, entryBarTime, { entryPrice = null, nowSec = Infinity } = {}) {
  const lead = [];
  const firstTime = bars.length ? bars[0].time : Infinity;
  if (firstTime !== entryBarTime) {
    if (!(entryPrice > 0)) return null;
    for (let time = entryBarTime; time < firstTime && time + BAR_SEC <= nowSec; time += BAR_SEC) {
      lead.push({ time, open: entryPrice, high: entryPrice, low: entryPrice, close: entryPrice, volume: 0 });
    }
    if (lead.length === 0) return null;
  }
  const all = [...lead, ...bars];
  const out = [all[0]];
  for (const b of all.slice(1)) {
    const prev = out[out.length - 1];
    for (let time = prev.time + BAR_SEC; time < b.time; time += BAR_SEC) {
      out.push({ time, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 });
    }
    out.push(b);
  }
  return out;
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
      const stored = Array.isArray(trade.bars) ? trade.bars : [];
      // Bar entry belum tersimpan: ambil lagi dari entry; kalau sudah, cukup sejak bar terakhir.
      const hasEntry = stored.length > 0 && stored[0].time === trade.entryBarTime;
      const lastTime = hasEntry ? stored[stored.length - 1].time : trade.entryBarTime - BAR_SEC;
      const limit = Math.max(0, Math.ceil((t / 1000 - lastTime) / BAR_SEC)) + 2;
      const candles = await d.fetchCandles(trade.baseMint, trade.pool, { resolution: "5m", limit });
      const fresh = closedBars(Array.isArray(candles) ? candles : [], t);
      const merged = mergeBars(stored, fresh, trade.entryBarTime);
      // Simpan riwayat walau belum bisa disimulasi: cache pendek tidak boleh menghilangkan bar lama.
      if (fresh.length > 0) patchTrade(trade.id, { bars: merged });
      const bars = fillGaps(merged, trade.entryBarTime, { entryPrice: trade.entryPrice, nowSec: t / 1000 });
      if (!bars) continue;
      if (!(bars[0].open > 0)) {
        warnOnce(trade.id, `bar entry tanpa harga (open=${bars[0].open})`);
        continue;
      }
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
      if (!Number.isFinite(res.pnlSol) || !Number.isFinite(res.pnlPct)) {
        warnOnce(trade.id, "hasil simulasi tidak valid (PnL bukan angka)");
        continue;
      }

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
