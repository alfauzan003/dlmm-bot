import log from "../core/logger.js";
import { fetchPoolPnl, usdPnlFromEntry } from "../meteora/positions.js";
import { getTrackedPosition } from "../state/positions.js";
import { exitPresetForNewTrade, isOn } from "../state/settings.js";
import {
  createTrade,
  findTradeByPosition,
  listOpenTrades,
  setTradeDepositUsd,
  settleTradeIfDone,
  tradeLock,
  updateTradeProgress,
} from "../state/trades.js";
import { closeTrade } from "../lp/close-trade.js";
import { isEntryInProgressPool } from "../entry/runtime.js";
import { handleClose } from "./close.js";
import { aggregateTradePnl, evaluateTradeExit } from "./trade-exit.js";

// Logika per-tick berbasis trade untuk loop exit (dipanggil dari exit/index.js).

function byAddress(positions) {
  const map = new Map();
  for (const p of positions || []) if (p?.position) map.set(p.position, p);
  return map;
}

function exitAllOff() {
  const preset = exitPresetForNewTrade();
  return {
    tp: { ...preset.tp, on: false },
    sl: { ...preset.sl, on: false },
    trail: { ...preset.trail, on: false },
  };
}

// Bungkus posisi live yang belum punya trade, isi depositUsd bila sudah diketahui,
// lalu selesaikan trade yang semua leg-nya sudah tertutup (oleh engine lama / di luar bot).
export function syncTrades(positions, { wasTracked = new Set() } = {}) {
  for (const pos of positions || []) {
    if (!pos?.position || findTradeByPosition(pos.position)) continue;
    // Pool sedang dibuka (open/entry/DCA berjalan): pembuka mencatat trade-nya sendiri, jangan dipecah.
    if (isEntryInProgressPool(pos.pool)) continue;
    const auto = wasTracked.has(pos.position);
    const trade = createTrade({
      pool: pos.pool,
      pair: pos.pair,
      baseMint: pos.baseMint,
      positions: [pos.position],
      origin: auto ? "auto" : "external",
      exit: auto ? exitPresetForNewTrade() : exitAllOff(),
    });
    log.info(`${pos.pair || pos.position.slice(0, 8)}: posisi diadopsi sebagai trade #${trade.id} (${trade.origin})`);
  }

  const live = byAddress(positions);
  for (const trade of listOpenTrades()) {
    if (trade.depositUsd == null) {
      const legs = trade.positions.map((addr) => live.get(addr));
      if (legs.length > 0 && legs.every((p) => p?.pnlKnown === true && p.depositUsd > 0)) {
        setTradeDepositUsd(
          trade.id,
          legs.reduce((s, p) => s + p.depositUsd, 0)
        );
      }
    }
    settleTradeIfDone(trade.id);
  }
}

// Selesaikan trade yang memuat alamat posisi yang baru ditandai hilang.
export function settleTradesForPositions(addresses) {
  const ids = new Set();
  for (const addr of addresses || []) {
    const trade = findTradeByPosition(addr);
    if (trade) ids.add(trade.id);
  }
  for (const id of ids) settleTradeIfDone(id);
}

// Baca ulang PnL pool secara paksa; null bila gagal atau ada leg yang tidak terbaca.
async function rereadTrade(trade, live, fetchPnl) {
  const fresh = await fetchPnl(trade.pool, { force: true, strict: true });
  if (!(fresh instanceof Map)) return null;
  const map = new Map();
  for (const addr of trade.positions) {
    const entry = fresh.get(addr);
    if (!entry) return null;
    const base = live.get(addr) ?? { position: addr, pool: trade.pool, pair: trade.pair, baseMint: trade.baseMint };
    map.set(addr, { ...base, ...usdPnlFromEntry(entry) });
  }
  return map;
}

// TP/SL/Trail per trade. Sebelum close, PnL dibaca ulang (paksa) dan dievaluasi lagi;
// close hanya bila masih terpicu. Mengembalikan id trade yang ditutup/terkunci tick ini.
export async function runTradeExits(positions, { deps = {} } = {}) {
  const fetchPnl = deps.fetchPoolPnl ?? fetchPoolPnl;
  const close = deps.closeTrade ?? closeTrade;
  const handled = new Set();
  const live = byAddress(positions);

  for (const trade of listOpenTrades()) {
    if (tradeLock(trade.id)) {
      handled.add(trade.id);
      continue;
    }
    const agg = aggregateTradePnl(trade, live);
    if (!agg) continue;

    const first = evaluateTradeExit(trade, agg.pnlPct);
    if (!first.reason) {
      updateTradeProgress(trade.id, { peakPnlPct: first.peakPnlPct, trailArmed: first.trailArmed });
      continue;
    }

    // Terpicu: baca ulang dulu. Kedua bacaan dievaluasi dari state trade sebelum
    // tick ini, dan progress (peak/arming) hanya disimpan bila terkonfirmasi, supaya
    // satu bacaan glitch tidak menggeser peak lalu memicu trail di tick berikutnya.
    const label = `${trade.pair || trade.pool?.slice(0, 8)} #${trade.id}`;
    const positionsByAddr = await rereadTrade(trade, live, fetchPnl);
    const freshAgg = positionsByAddr ? aggregateTradePnl(trade, positionsByAddr) : null;
    if (!freshAgg) {
      log.warn(`${label}: ${first.reason} terpicu tapi baca ulang PnL gagal/tidak lengkap — tunda`);
      continue;
    }
    const second = evaluateTradeExit(trade, freshAgg.pnlPct);
    if (!second.reason) {
      log.info(`${label}: ${first.reason} tidak terkonfirmasi (PnL ulang ${freshAgg.pnlPct.toFixed(2)}%) — tahan`);
      continue;
    }
    // Progress hanya dari bacaan ulang yang terkonfirmasi.
    updateTradeProgress(trade.id, { peakPnlPct: second.peakPnlPct, trailArmed: second.trailArmed });

    // closeTrade mengunci trade sendiri (busy bila sudah terkunci).
    handled.add(trade.id);
    log.info(`${label}: ${second.reason} terkonfirmasi (PnL ${freshAgg.pnlPct.toFixed(2)}%) → close trade`);
    try {
      await close(trade, { reason: second.reason, swap: true, positionsByAddr });
    } catch (err) {
      log.error(`${label}: close trade error: ${err.message}`);
    }
  }
  return handled;
}

// Penutup sadar-trade untuk engine deterministik (termasuk timer trailing):
// trade multi-leg → closeTrade (semua leg), satu leg → handleClose lama.
// Trade terkunci atau posisi yang sudah tertutup dilewati.
export async function tradeAwareClose(pos, reason, opts, { positionsByAddr, deps = {} } = {}) {
  const closeWhole = deps.closeTrade ?? closeTrade;
  const closeOne = deps.handleClose ?? handleClose;
  // Timer trailing bisa menyala setelah toggle deterministik dimatikan.
  if (!isOn("deterministicExit")) return { success: false, skipped: true };
  const trade = findTradeByPosition(pos?.position);
  if (trade && tradeLock(trade.id)) {
    log.info(`${pos.pair || pos.position.slice(0, 8)}: trade #${trade.id} sedang diproses — skip close (${reason})`);
    return { success: false, busy: true };
  }
  if (getTrackedPosition(pos?.position)?.closed === true) return { success: false, skipped: true };
  if (trade && trade.positions.length > 1) {
    return closeWhole(trade, { reason, swap: true, positionsByAddr: positionsByAddr ?? byAddress([pos]) });
  }
  return closeOne(pos, reason, opts);
}
