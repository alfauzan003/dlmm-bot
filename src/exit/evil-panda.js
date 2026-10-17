// Exit Evil Panda per trade: tahan selama harga di atas Supertrend 15m; setelah bar tutup menembus ke
// bawah (armed), close pada spike berikutnya (RSI / MACD / BB yang aktif). Bar yang tutup kembali di atas
// Supertrend membatalkan arming. Arming selalu dari bar 15m tutup; spike dicek pada bar tutup dan, bila
// EVIL_PANDA_SIGNAL_MODE=live, juga pada harga live (bar yang sedang terbentuk).
import config from "../config/index.js";
import log from "../core/logger.js";
import { fetchCandles } from "../market/candles.js";
import { getPrices } from "../market/jupiter-price.js";
import { bollinger, macd, rsi } from "../market/indicators.js";
import { supertrendSeries } from "../market/supertrend.js";
import { fetchPoolPnl } from "../meteora/positions.js";
import { getTrade, listOpenTrades, tradeLock, updateTradePanda } from "../state/trades.js";
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

// Baris untuk bar yang sedang terbentuk: harga live dianggap close-nya (indikator dihitung ulang dengan
// harga itu). Arah = apakah harga live masih di bawah garis Supertrend bar tutup terakhir.
export function liveRow(closedCandles, price, params) {
  const last = closedCandles[closedCandles.length - 1];
  const forming = { time: last.time + BAR_SEC, open: last.close, high: price, low: price, close: price, volume: 0 };
  return pandaRows([...closedCandles, forming], params).at(-1);
}

// Sinyal live: hanya saat armed dan harga live masih di bawah Supertrend (di atasnya = tahan, seperti bar tutup).
export function livePandaSignal(progress, row, params) {
  if (progress?.armed !== true || row?.direction !== "bearish") return null;
  return signalOf(row, params);
}

// Proses bar setelah progress.lastBar (pertama kali: mulai bar saat trade dibuka). Hanya bar terakhir
// (bar tutup terbaru) yang boleh memicu close; spike di bar lama (replay setelah restart / Panda baru
// dinyalakan) hanya memperbarui arming. Saat terpicu, lastBar tetap di bar sebelumnya supaya close yang
// gagal dicoba lagi tick berikutnya.
export function stepPanda(progress, rows, params, { openedAtSec = 0 } = {}) {
  const next = { seenAbove: false, armed: false, lastBar: null, ...(progress || {}) };
  const from = next.lastBar == null ? barStart(openedAtSec) : next.lastBar + 1;
  const newest = rows.length ? rows[rows.length - 1].time : null;
  for (const row of rows) {
    if (row.time < from) continue;
    if (row.direction === "bullish") {
      next.seenAbove = true;
      next.armed = false;
    } else if (row.direction === "bearish" && next.seenAbove) {
      next.armed = true;
      const signal = row.time === newest ? signalOf(row, params) : null;
      if (signal) return { progress: next, fire: { signal, time: row.time } };
    }
    next.lastBar = row.time;
  }
  return { progress: next, fire: null };
}

let warnedMacd = false;

const norm = (p) => [p?.seenAbove ?? false, p?.armed ?? false, p?.lastBar ?? null].join("|");
const sameProgress = (a, b) => norm(a) === norm(b);
const pandaStillOn = (id) => {
  const t = getTrade(id);
  return t && t.closed !== true && t.exit?.panda?.on === true ? t : null;
};

// Candle tidak lengkap (GMGN telat / token sepi): coba lagi paling cepat tiap 60 dtk, maks 3x per bar,
// supaya kuota GMGN (dipakai bersama Auto Entry) tidak habis tiap tick.
const RETRY_GAP_MS = 60_000;
const MAX_TRIES_PER_BAR = 3;
const retries = new Map(); // mint -> { bar, tries, lastAt }
// Candle tutup per mint untuk bar berjalan: trade yang armed (mode live) tidak fetch ulang tiap tick.
const barCandles = new Map(); // mint -> { bar, closed }
export const __resetPandaThrottle = () => {
  retries.clear();
  barCandles.clear();
};

function throttled(mint, bar, now) {
  const r = retries.get(mint);
  if (!r || r.bar !== bar) return false;
  return r.tries >= MAX_TRIES_PER_BAR || now - r.lastAt < RETRY_GAP_MS;
}

function noteIncomplete(mint, bar, now) {
  const r = retries.get(mint);
  retries.set(mint, { bar, tries: r?.bar === bar ? r.tries + 1 : 1, lastAt: now });
}

// Satu tick dari loop monitor posisi: evaluasi bar 15m yang baru tutup untuk tiap trade dengan Panda ON,
// lalu close trade yang terpicu. Mengembalikan id trade yang dicoba ditutup.
export async function runEvilPanda(positions, { deps = {}, now = Date.now() } = {}) {
  const fetchCandlesFn = deps.fetchCandles ?? fetchCandles;
  const getPricesFn = deps.getPrices ?? getPrices;
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
  const liveMode = params.signalMode === "live";
  const closedByMint = new Map(); // mint -> Promise<closed candles | null> (sekali per run)
  const handled = new Set();

  function loadClosed(mint, pool, label) {
    const cached = barCandles.get(mint);
    if (cached?.bar === latestClosed) return Promise.resolve(cached.closed);
    if (throttled(mint, latestClosed, now)) return Promise.resolve(null);
    return fetchCandlesFn(mint, pool, { resolution: "15m", limit: 90, allowStale: false })
      .then((candles) => closedBars(candles, now))
      .catch((err) => {
        log.warn(`${label}: Evil Panda candle 15m gagal: ${err.message}`);
        return null;
      })
      .then((closed) => {
        if (closed) {
          retries.delete(mint);
          barCandles.set(mint, { bar: latestClosed, closed });
        } else noteIncomplete(mint, latestClosed, now);
        return closed;
      });
  }

  const trades = listOpenTrades().filter(
    (t) => t.exit?.panda?.on === true && !tradeLock(t.id) && t.positions.some((addr) => live.has(addr))
  );
  // Harga live: satu request batch per run, hanya bila ada trade armed yang membutuhkannya.
  let prices = null;
  const livePrices = () =>
    (prices ??= getPricesFn([...new Set(trades.map((t) => t.baseMint).filter(Boolean))], { force: true }).catch(
      () => new Map()
    ));

  for (const trade of trades) {
    const needClosed = trade.panda?.lastBar == null || trade.panda.lastBar < latestClosed;
    if (!needClosed && !(liveMode && trade.panda?.armed === true)) continue;

    const label = `${trade.pair || trade.pool?.slice(0, 8)} #${trade.id}`;
    const mint = trade.baseMint;
    if (!closedByMint.has(mint)) closedByMint.set(mint, loadClosed(mint, trade.pool, label));
    const closed = await closedByMint.get(mint);
    if (!closed) continue;

    // Trade dibaca ulang setelah await: Panda bisa dimatikan / di-reset selama candle dimuat.
    const fresh = pandaStillOn(trade.id);
    if (!fresh || !sameProgress(trade.panda, fresh.panda)) continue;

    let progress = trade.panda;
    let fire = null;
    if (needClosed) {
      const openedAtSec = (trade.openedAt || 0) / 1000;
      ({ progress, fire } = stepPanda(trade.panda, pandaRows(closed, params), params, { openedAtSec }));
      if (!sameProgress(trade.panda, progress)) {
        updateTradePanda(trade.id, progress);
        const wasArmed = trade.panda?.armed === true;
        if (progress.armed && !wasArmed) log.info(`${label}: Evil Panda armed (Supertrend broke)`);
        if (!progress.armed && wasArmed) log.info(`${label}: Evil Panda disarmed (back above Supertrend)`);
      }
    }
    if (!fire && liveMode && progress?.armed === true) {
      const price = (await livePrices()).get(mint);
      if (Number.isFinite(price)) {
        const row = liveRow(closed, price, params);
        const signal = livePandaSignal(progress, row, params);
        if (signal) fire = { signal, time: row.time, price };
      }
    }
    if (!fire) continue;

    handled.add(trade.id);
    const positionsByAddr = await rereadTrade(trade, live, fetchPnl);
    if (!positionsByAddr) {
      log.warn(`${label}: Evil Panda (${fire.signal}) terpicu tapi baca ulang PnL gagal — tunda`);
      continue;
    }
    if (!pandaStillOn(trade.id)) continue;
    log.info(
      `${label}: Evil Panda ${fire.signal} spike${fire.price != null ? ` (live ${fire.price})` : ""} → close trade`
    );
    try {
      await close(trade, { reason: `evil_panda_${fire.signal}`, swap: true, positionsByAddr });
    } catch (err) {
      log.error(`${label}: Evil Panda close error: ${err.message}`);
    }
  }
  return handled;
}

// Jalankan runEvilPanda di latar belakang (fetch GMGN bisa antre lama; loop monitor tidak ikut menunggu).
// Satu run sekaligus: null bila run sebelumnya masih berjalan.
let running = null;
export function kickEvilPanda(positions, opts) {
  if (running) return null;
  running = runEvilPanda(positions, opts)
    .catch((err) => log.error(`Evil Panda error: ${err.message}`))
    .finally(() => {
      running = null;
    });
  return running;
}
