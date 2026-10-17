// Exit Evil Panda per trade (murni): tahan selama harga di atas Supertrend 15m; setelah bar tutup
// menembus ke bawah (armed), close pada spike berikutnya (RSI / MACD / BB yang aktif). Bar yang tutup
// kembali di atas Supertrend membatalkan arming. Hanya bar 15m yang sudah tutup yang dipakai.
import config from "../config/index.js";
import log from "../core/logger.js";
import { fetchCandles } from "../market/candles.js";
import { bollinger, macd, rsi } from "../market/indicators.js";
import { supertrendSeries } from "../market/supertrend.js";
import { fetchPoolPnl } from "../meteora/positions.js";
import { listOpenTrades, tradeLock, updateTradePanda } from "../state/trades.js";
import { closeTrade } from "../lp/close-trade.js";
import { rereadTrade } from "./trade-loop.js";

const BAR_SEC = 900;
const barStart = (sec) => Math.floor(sec / BAR_SEC) * BAR_SEC;

// Candle yang sudah tutup saja. null bila bar tutup terakhir belum ada (data belum final).
export function closedBars(candles, nowMs = Date.now()) {
  const current = barStart(nowMs / 1000);
  const closed = (candles || []).filter((c) => barStart(c.time) < current);
  if (closed.length === 0 || barStart(closed[closed.length - 1].time) !== current - BAR_SEC) return null;
  return closed;
}

// Satu baris per candle: arah Supertrend + nilai sinyal. Arah null selama 2×periode ATR pertama
// (warm-up Supertrend belum stabil); MACD null bila slow <= fast.
export function pandaRows(candles, params) {
  const closes = candles.map((c) => c.close);
  const st = supertrendSeries(candles, params.stAtrPeriod, params.stMultiplier);
  const r = rsi(closes, params.rsi.length);
  const m =
    params.macd.slow > params.macd.fast ? macd(closes, params.macd.fast, params.macd.slow, params.macd.signal) : null;
  const bb = bollinger(closes, params.bb.length, params.bb.stdDev);
  return candles.map((c, i) => ({
    time: c.time,
    close: c.close,
    direction: i < 2 * params.stAtrPeriod ? null : (st[i]?.direction ?? null),
    rsi: r[i],
    hist: m?.hist[i] ?? null,
    prevHist: i > 0 ? (m?.hist[i - 1] ?? null) : null,
    upper: bb.upper[i],
  }));
}

function signalOf(row, params) {
  if (params.rsi.on && row.rsi != null && row.rsi > params.rsi.level) return "rsi";
  if (params.macd.on && row.hist != null && row.prevHist != null && row.hist > 0 && row.prevHist <= 0) return "macd";
  if (params.bb.on && row.upper != null && row.close > row.upper) return "bb";
  return null;
}

// Proses bar setelah progress.lastBar (pertama kali: mulai bar saat trade dibuka). Saat terpicu,
// lastBar tetap di bar sebelumnya supaya close yang gagal dicoba lagi tick berikutnya.
export function stepPanda(progress, rows, params, { openedAtSec = 0 } = {}) {
  const next = { seenAbove: false, armed: false, lastBar: null, ...(progress || {}) };
  const from = next.lastBar == null ? barStart(openedAtSec) : next.lastBar + 1;
  for (const row of rows) {
    if (row.time < from) continue;
    if (row.direction === "bullish") {
      next.seenAbove = true;
      next.armed = false;
    } else if (row.direction === "bearish" && next.seenAbove) {
      next.armed = true;
      const signal = signalOf(row, params);
      if (signal) return { progress: next, fire: { signal, time: row.time } };
    }
    next.lastBar = row.time;
  }
  return { progress: next, fire: null };
}

let warnedMacd = false;

const sameProgress = (a, b) =>
  (a?.seenAbove ?? false) === b.seenAbove && (a?.armed ?? false) === b.armed && (a?.lastBar ?? null) === b.lastBar;

// Satu tick dari loop monitor posisi: evaluasi bar 15m yang baru tutup untuk tiap trade dengan Panda ON,
// lalu close trade yang terpicu. Mengembalikan id trade yang dicoba ditutup.
export async function runEvilPanda(positions, { deps = {}, now = Date.now() } = {}) {
  const fetchCandlesFn = deps.fetchCandles ?? fetchCandles;
  const fetchPnl = deps.fetchPoolPnl ?? fetchPoolPnl;
  const close = deps.closeTrade ?? closeTrade;
  const params = config.evilPanda;
  if (params.macd.on && params.macd.slow <= params.macd.fast && !warnedMacd) {
    warnedMacd = true;
    log.warn("EVIL_PANDA_MACD_SLOW must be greater than EVIL_PANDA_MACD_FAST — MACD signal off");
  }

  const live = new Map();
  for (const p of positions || []) if (p?.position) live.set(p.position, p);
  const latestClosed = barStart(now / 1000) - BAR_SEC;
  const rowsByMint = new Map(); // mint -> Promise<rows | null>
  const handled = new Set();

  for (const trade of listOpenTrades()) {
    if (trade.exit?.panda?.on !== true || tradeLock(trade.id)) continue;
    if (!trade.positions.some((addr) => live.has(addr))) continue;
    if (trade.panda?.lastBar != null && trade.panda.lastBar >= latestClosed) continue;

    const label = `${trade.pair || trade.pool?.slice(0, 8)} #${trade.id}`;
    if (!rowsByMint.has(trade.baseMint)) {
      rowsByMint.set(
        trade.baseMint,
        fetchCandlesFn(trade.baseMint, trade.pool, { resolution: "15m", limit: 90, allowStale: false })
          .then((candles) => {
            const closed = closedBars(candles, now);
            return closed ? pandaRows(closed, params) : null;
          })
          .catch((err) => {
            log.warn(`${label}: Evil Panda candle 15m gagal: ${err.message}`);
            return null;
          })
      );
    }
    const rows = await rowsByMint.get(trade.baseMint);
    if (!rows) continue;

    const { progress, fire } = stepPanda(trade.panda, rows, params, { openedAtSec: (trade.openedAt || 0) / 1000 });
    if (!sameProgress(trade.panda, progress)) {
      updateTradePanda(trade.id, progress);
      const wasArmed = trade.panda?.armed === true;
      if (progress.armed && !wasArmed) log.info(`${label}: Evil Panda armed (Supertrend broke)`);
      if (!progress.armed && wasArmed) log.info(`${label}: Evil Panda disarmed (back above Supertrend)`);
    }
    if (!fire) continue;

    handled.add(trade.id);
    const positionsByAddr = await rereadTrade(trade, live, fetchPnl);
    if (!positionsByAddr) {
      log.warn(`${label}: Evil Panda (${fire.signal}) terpicu tapi baca ulang PnL gagal — tunda`);
      continue;
    }
    log.info(`${label}: Evil Panda ${fire.signal} spike → close trade`);
    try {
      await close(trade, { reason: `evil_panda_${fire.signal}`, swap: true, positionsByAddr });
    } catch (err) {
      log.error(`${label}: Evil Panda close error: ${err.message}`);
    }
  }
  return handled;
}
