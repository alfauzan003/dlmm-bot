import log from "../core/logger.js";
import { sleep } from "../core/utils.js";
import { readState } from "../state/store.js";
import { fetchPoolPnl, usdPnlFromEntry } from "../meteora/positions.js";
import { getOpenTrackedPositions, getTrackedPosition } from "../state/positions.js";
import { exitPresetForNewTrade } from "../state/settings.js";
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
import { notifyClosedButLive } from "../notify/telegram.js";
import { isEntryInProgressPool } from "../entry/runtime.js";
import { aggregateTradePnl, evaluateTradeExit, tradeExitDetail } from "./trade-exit.js";

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
    panda: { on: false },
  };
}

// Waktu proses ini mulai. Posisi yang sudah di-track sebelum ini = posisi bot lama (legacy).
export const PROCESS_BOOT_AT = Date.now();

// Posisi bot lama (di-track sebelum boot ini, atau tanpa firstSeenAt) — diadopsi tanpa exit.
function isLegacy(tracked, bootedAt) {
  return !(Number.isFinite(tracked?.firstSeenAt) && tracked.firstSeenAt >= bootedAt);
}

// Berapa posisi lama yang akan diadopsi tanpa TP/SL (untuk pesan online saat boot).
export function legacyAdoptionCount({ bootedAt = PROCESS_BOOT_AT } = {}) {
  const owned = new Set();
  for (const t of Object.values(readState().trades || {})) for (const addr of t?.positions || []) owned.add(addr);
  return getOpenTrackedPositions().filter((p) => p.position && !owned.has(p.position) && isLegacy(p, bootedAt)).length;
}

// Alamat closed-tapi-masih-live yang sudah diperingatkan (sekali per alamat).
const warnedClosedLive = new Set();

// Bungkus posisi live yang belum punya trade, isi depositUsd bila sudah diketahui,
// lalu selesaikan trade yang semua leg-nya sudah tertutup (di luar bot).
export function syncTrades(positions, { wasTracked = new Set(), bootedAt = PROCESS_BOOT_AT } = {}) {
  for (const pos of positions || []) {
    if (!pos?.position || findTradeByPosition(pos.position)) continue;
    // Pool sedang dibuka (open/entry berjalan): pembuka mencatat trade-nya sendiri, jangan dipecah.
    if (isEntryInProgressPool(pos.pool)) continue;
    // Sudah ditandai closed di state (DRY_RUN close, RPC tertinggal, salah deteksi hilang): jangan
    // diadopsi lagi — trade baru akan langsung diselesaikan dan PnL terhitung dobel tiap tick.
    if (getTrackedPosition(pos.position)?.closed === true) {
      if (!warnedClosedLive.has(pos.position)) {
        warnedClosedLive.add(pos.position);
        log.warn(
          `${pos.pair || pos.position.slice(0, 8)}: posisi masih terbaca live tapi sudah closed di state — tidak diadopsi`
        );
        notifyClosedButLive(pos.position);
      }
      continue;
    }
    const auto = wasTracked.has(pos.position);
    // Hanya posisi yang di-track selama proses ini mendapat preset Auto Exit; posisi bot lama
    // (sebelum upgrade/restart) diadopsi tanpa exit supaya tidak langsung dijual saat boot.
    const preset = auto && !isLegacy(getTrackedPosition(pos.position), bootedAt);
    const trade = createTrade({
      pool: pos.pool,
      pair: pos.pair,
      baseMint: pos.baseMint,
      positions: [pos.position],
      origin: auto ? "auto" : "external",
      exit: preset ? exitPresetForNewTrade() : exitAllOff(),
    });
    // Alamat sudah milik trade tertutup (createTrade menolak membuat ulang).
    if (trade.closed === true) continue;
    log.info(
      `${pos.pair || pos.position.slice(0, 8)}: posisi diadopsi sebagai trade #${trade.id} (${trade.origin}${auto && !preset ? ", lama — tanpa exit" : ""})`
    );
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
  }
  settleOpenTrades();
}

// Selesaikan setiap trade terbuka yang semua leg-nya sudah closed di state (mis. leg terakhir
// ditutup di luar bot). Dipanggil juga saat tidak ada posisi live (loop exit berhenti lebih awal).
// Trade terkunci dilewati: penutupnya (closeTrade) menyelesaikan trade dan mengirim alert sendiri.
export function settleOpenTrades() {
  for (const trade of listOpenTrades()) if (!tradeLock(trade.id)) settleTradeIfDone(trade.id);
}

// Selesaikan trade yang memuat alamat posisi yang baru ditandai hilang.
export function settleTradesForPositions(addresses) {
  const ids = new Set();
  for (const addr of addresses || []) {
    const trade = findTradeByPosition(addr);
    if (trade) ids.add(trade.id);
  }
  for (const id of ids) if (!tradeLock(id)) settleTradeIfDone(id);
}

// Leg yang sudah tertutup di state tidak ikut PnL trade (sisa leg tetap punya TP/SL/Trail).
const isLegClosed = (addr) => getTrackedPosition(addr)?.closed === true;

// Baca ulang PnL pool secara paksa; null bila gagal atau ada leg terbuka yang tidak terbaca.
export async function rereadTrade(trade, live, fetchPnl) {
  const fresh = await fetchPnl(trade.pool, { force: true, strict: true });
  if (!(fresh instanceof Map)) return null;
  const map = new Map();
  for (const addr of trade.positions) {
    if (isLegClosed(addr)) continue;
    const entry = fresh.get(addr);
    if (!entry) return null;
    const base = live.get(addr) ?? { position: addr, pool: trade.pool, pair: trade.pair, baseMint: trade.baseMint };
    map.set(addr, { ...base, ...usdPnlFromEntry(entry) });
  }
  return map;
}

// Menit pertama setelah open TP/SL/Trail tidak dievaluasi: PnL Meteora posisi baru sering
// belum lengkap ter-index (mis. -100% beberapa detik setelah open) dan memicu SL palsu.
export const EXIT_GRACE_MS = 60_000;
const inExitGrace = (t) => Number.isFinite(t.openedAt) && Date.now() - t.openedAt < EXIT_GRACE_MS;

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
    if (inExitGrace(trade)) continue;
    const agg = aggregateTradePnl(trade, live, { isClosed: isLegClosed });
    if (!agg) continue;

    const first = evaluateTradeExit(trade, agg.pnlPct);
    if (!first.reason) {
      // Tulis state hanya bila berubah (loop cepat jalan tiap detik).
      const prevPeak = Number.isFinite(trade.peakPnlPct) ? trade.peakPnlPct : null;
      if (first.peakPnlPct !== prevPeak || first.trailArmed !== (trade.trailArmed === true)) {
        updateTradeProgress(trade.id, { peakPnlPct: first.peakPnlPct, trailArmed: first.trailArmed });
      }
      continue;
    }

    // Terpicu: baca ulang dulu. Kedua bacaan dievaluasi dari state trade sebelum
    // tick ini, dan progress (peak/arming) hanya disimpan bila terkonfirmasi, supaya
    // satu bacaan glitch tidak menggeser peak lalu memicu trail di tick berikutnya.
    const label = `${trade.pair || trade.pool?.slice(0, 8)} #${trade.id}`;
    const positionsByAddr = await rereadTrade(trade, live, fetchPnl);
    const freshAgg = positionsByAddr ? aggregateTradePnl(trade, positionsByAddr, { isClosed: isLegClosed }) : null;
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
    const detail = tradeExitDetail(second.reason, trade, freshAgg.pnlPct, second.peakPnlPct);
    log.info(`${label}: ${second.reason} terkonfirmasi (${detail ?? `PnL ${freshAgg.pnlPct.toFixed(2)}%`}) → close trade`);
    try {
      await close(trade, { reason: second.reason, detail, swap: true, positionsByAddr });
    } catch (err) {
      log.error(`${label}: close trade error: ${err.message}`);
    }
  }
  return handled;
}

// Snapshot posisi live dari siklus terakhir loop utama (on-chain). Loop cepat hanya
// memakai posisi yang ada di sini: posisi yang sudah hilang on-chain tapi masih
// "open" di Meteora tidak dicoba ditutup berulang-ulang.
let livePositions = [];
export function setLivePositions(positions) {
  livePositions = Array.isArray(positions) ? positions : [];
}

const hasExitOn = (t) => t.exit?.tp?.on === true || t.exit?.sl?.on === true || t.exit?.trail?.on === true;

// Satu tick loop TP/SL/Trail cepat: baca PnL segar (satu request per pool) untuk trade
// terbuka yang punya exit aktif, lalu jalankan runTradeExits.
export async function runFastTradeExitTick({ positions = livePositions, deps = {} } = {}) {
  const fetchPnl = deps.fetchPoolPnl ?? fetchPoolPnl;
  const base = byAddress(positions);
  const pools = new Set();
  for (const t of listOpenTrades()) {
    if (hasExitOn(t) && !tradeLock(t.id) && !inExitGrace(t) && t.positions.some((addr) => base.has(addr))) pools.add(t.pool);
  }
  if (pools.size === 0) return new Set();

  const fresh = [];
  for (const pool of pools) {
    const map = await fetchPnl(pool, { force: true, strict: true });
    if (!(map instanceof Map)) continue;
    for (const [addr, entry] of map) {
      const pos = base.get(addr);
      if (pos) fresh.push({ ...pos, ...usdPnlFromEntry(entry) });
    }
  }
  return runTradeExits(fresh, { deps });
}

// Loop TP/SL/Trail: tick dimulai tiap `intervalSec` (lebih lambat bila fetch lebih lama).
export async function tradeExitLoop(intervalSec) {
  const intervalMs = intervalSec * 1000;
  for (;;) {
    const started = Date.now();
    try {
      await runFastTradeExitTick();
    } catch (err) {
      log.error(`Trade exit error: ${err.message}`);
    }
    await sleep(Math.max(0, intervalMs - (Date.now() - started)));
  }
}
