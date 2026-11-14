// Runner ping-pong bidask flip (trade auto dengan BIDASK_FLIP_MODE=pingpong): tiap bar 15m tutup (GMGN),
// jalankan mesin status strategy/pingpong.js lalu flip token ke atas harga atau pindahkan SOL ke bawah
// harga. Fase drain: trade ditutup exit strategi (trend_done) saat semua token terjual; dengan
// BIDASK_DRAIN_EXIT, drain trend_up tetap dipantau sampai tren gagal (trend_failed). Dipanggil tiap siklus loop exit utama, di latar belakang (antrean GMGN tidak menahan loop).
import log from "../core/logger.js";
import { fetchCandles } from "../market/candles.js";
import { canFlip, flipTrade } from "../lp/flip-trade.js";
import { notifyPingPong } from "../notify/telegram.js";
import { getTrackedPosition } from "../state/positions.js";
import { getTrade, listOpenTrades, setTradeAutoFlip, setTradePingPong, tradeLock } from "../state/trades.js";
import { tokenPos } from "../strategy/exits.js";
import { commitPingPong, initialPingPong, ppRows, samePingPong, stepPingPong } from "../strategy/pingpong.js";
import { fmtToken } from "../tg/format.js";
import { closedBars } from "./evil-panda.js";

const BAR_SEC = 900;
const barStart = (sec) => Math.floor(sec / BAR_SEC) * BAR_SEC;
const isLegClosed = (addr) => getTrackedPosition(addr)?.closed === true;

export const isPingPongTrade = (t) => t?.strategy?.params?.flipMode === "pingpong" && canFlip(t);

// Drain trend_up dengan exit drain aktif tetap butuh bar 15m (deteksi tren gagal); drain lain selesai.
const watchesDrain = (t) =>
  t.strategy.params.drainExit === true && t.pingpong?.drainReason === "trend_up" && !t.pingpong?.trendFailed;

// Teks lanjutan notifikasi saat ping-pong berakhir.
function drainNext(drained, p) {
  if (p.drainExit === true && drained.reason === "weak") return "The remaining tokens are sold now (drain_weak).";
  if (p.drainExit === true && drained.reason === "trend_up") {
    return "The tokens sell out, then the trade closes (trend_done) — or earlier if a 15m bar closes back below the Supertrend (trend_failed).";
  }
  return "The tokens sell out, then the trade closes (trend_done).";
}

// Harga di atas semua leg terbuka (semua token sudah terjual jadi SOL). false bila bin tidak diketahui.
export function allLegsSold(trade, live) {
  const legs = (trade.positions || [])
    .filter((addr) => !isLegClosed(addr))
    .map((addr) => live.get(addr))
    .filter((l) => l && [l.activeBin, l.lowerBin, l.upperBin].every(Number.isFinite));
  if (legs.length === 0) return false;
  const xIsSol = legs[0].xIsSol === true;
  const top = Math.max(...legs.flatMap((l) => [tokenPos(l.lowerBin, xIsSol), tokenPos(l.upperBin, xIsSol)]));
  return tokenPos(legs[0].activeBin, xIsSol) > top;
}

function failReason(res) {
  if (res.redepositFailed) return "withdrawn but re-deposit failed — kept in the wallet";
  return res.error ?? "unknown error";
}

// Teks notifikasi (polos). outcome = hasil commitPingPong ("done" / "skip" / "stuck").
export function pingPongMessage(trade, fire, res, outcome, next) {
  const head = `🏓 Ping-pong #${trade.id} ${trade.pair}`;
  const n = res.binCount;
  const reverse = fire.action === "reverse";
  const what = reverse ? `move the SOL of ${n} sold bins back below the price` : `flip ${n} token bins above the price`;
  if (res.dryRun) return `🧪 DRY RUN — ${head} would ${what} (${fire.why}).`;
  if (outcome === "done") {
    return reverse
      ? `${head}: ${fire.why} → moved ${fmtToken(res.tokenAmount)} SOL from ${n} sold bins back below the price (round ${next.round}). Next: flip tokens up after a ${trade.strategy.params.ppDipMinPct}% dip and a reversal bar.`
      : `${head}: ${fire.why} → flipped ${n} bins (${fmtToken(res.tokenAmount)} token) above the price — round ${next.round}.`;
  }
  if (outcome === "stuck") {
    return `⚠️ ${head}: could not ${what}: ${failReason(res)}. No more ping-pong — the tokens sell out, then the trade closes.`;
  }
  return `⚠️ ${head}: could not ${what}: ${failReason(res)}. Waiting for the next signal.`;
}

// Candle 15m tidak lengkap (GMGN telat / token sepi): coba lagi paling cepat tiap 60 dtk, maks 3x per bar.
const RETRY_GAP_MS = 60_000;
const MAX_TRIES_PER_BAR = 3;
const retries = new Map(); // mint -> { bar, tries, lastAt }
const barCandles = new Map(); // mint -> { bar, closed }
export const __resetPingPongThrottle = () => {
  retries.clear();
  barCandles.clear();
};

// Satu tick: evaluasi trade ping-pong pada bar 15m tutup terbaru, lalu flip / balik yang terpicu.
export async function runPingPong(positions, { deps = {}, now = Date.now() } = {}) {
  const fetchCandlesFn = deps.fetchCandles ?? fetchCandles;
  const flip = deps.flipTrade ?? flipTrade;
  const notify = deps.notify ?? notifyPingPong;
  const toRows = deps.ppRows ?? ppRows;
  const live = new Map((positions || []).filter((p) => p?.position).map((p) => [p.position, p]));
  const latestClosed = barStart(now / 1000) - BAR_SEC;
  const closedByMint = new Map();

  function loadClosed(mint, pool, label) {
    const cached = barCandles.get(mint);
    if (cached?.bar === latestClosed) return Promise.resolve(cached.closed);
    const r = retries.get(mint);
    if (r?.bar === latestClosed && (r.tries >= MAX_TRIES_PER_BAR || now - r.lastAt < RETRY_GAP_MS)) {
      return Promise.resolve(null);
    }
    return fetchCandlesFn(mint, pool, { resolution: "15m", limit: 100, allowStale: false })
      .then((candles) => closedBars(candles, now))
      .catch((err) => {
        log.warn(`${label}: ping-pong candle 15m gagal: ${err.message}`);
        return null;
      })
      .then((closed) => {
        if (closed) {
          retries.delete(mint);
          barCandles.set(mint, { bar: latestClosed, closed });
        } else {
          retries.set(mint, { bar: latestClosed, tries: r?.bar === latestClosed ? r.tries + 1 : 1, lastAt: now });
        }
        return closed;
      });
  }

  const trades = listOpenTrades().filter(
    (t) =>
      isPingPongTrade(t) &&
      (t.pingpong?.phase !== "drain" || watchesDrain(t)) &&
      !tradeLock(t.id) &&
      t.positions.some((a) => live.has(a))
  );
  for (const trade of trades) {
    const label = `${trade.pair || trade.pool?.slice(0, 8)} #${trade.id}`;
    const p = trade.strategy.params;
    const state = { ...initialPingPong(), ...(trade.pingpong || {}) };
    const flipped = (trade.flipLegs?.length ?? 0) > 0;
    let rows = [];
    if (state.lastBar == null || state.lastBar < latestClosed) {
      const mint = trade.baseMint;
      if (!closedByMint.has(mint)) closedByMint.set(mint, loadClosed(mint, trade.pool, label));
      const closed = await closedByMint.get(mint);
      if (closed) rows = toRows(closed, p);
    }
    if (rows.length === 0 && !(state.phase === "first" && flipped)) continue;

    // Dibaca ulang setelah await: trade bisa tertutup / berubah selama candle dimuat.
    const fresh = getTrade(trade.id);
    if (!fresh || fresh.closed === true || !samePingPong(fresh.pingpong, trade.pingpong) || tradeLock(trade.id)) continue;

    const { state: next, fire, drained } = stepPingPong(state, rows, p, { flipped, allSold: allLegsSold(fresh, live) });
    if (!samePingPong(next, trade.pingpong)) setTradePingPong(trade.id, next);
    if (state.entryTrend == null && next.entryTrend === "bullish") {
      if (fresh.autoFlip) setTradeAutoFlip(trade.id, null);
      log.info(`${label}: ping-pong — Supertrend 15m bullish saat entry, flip pertama saat bar tutup di bawahnya`);
      notify(
        `🏓 Ping-pong #${trade.id} ${trade.pair}: 15m Supertrend is bullish at entry — the first flip happens when a 15m bar closes below it (pct auto flip off).`
      );
    }
    // Setelah flip pertama, flip berikutnya hanya dari ping-pong.
    if (next.phase !== "first" && fresh.autoFlip) setTradeAutoFlip(trade.id, null);
    if (state.phase === "first" && next.phase === "ask") log.info(`${label}: ping-pong — flip pertama selesai, putaran 1`);
    if (drained) {
      log.info(`${label}: ping-pong selesai (${drained.reason}: ${drained.detail}) — token dibiarkan habis terjual`);
      notify(`🏓 Ping-pong #${trade.id} ${trade.pair} ends: ${drained.detail}. ${drainNext(drained, p)}`);
    }
    if (!state.trendFailed && next.trendFailed) {
      log.info(`${label}: ping-pong drain — Supertrend 15m kembali bearish, tren gagal → trend_failed`);
    }
    if (!fire) continue;

    const side = fire.action === "reverse" ? "sol" : "token";
    log.info(`${label}: ping-pong ${fire.action} (${fire.why})`);
    let res;
    try {
      res = await flip(fresh, { side });
    } catch (err) {
      log.warn(`${label}: ping-pong ${fire.action} error (${err?.message ?? err}) — coba lagi tick berikutnya`);
      continue;
    }
    if (!res || res.busy || res.poolBusy) {
      log.info(`${label}: trade/pool sibuk — ping-pong dicoba lagi tick berikutnya`);
      continue;
    }
    let outcome = "skip";
    if (res.success) outcome = "done";
    else if (res.redepositFailed || res.cap) outcome = "stuck";
    const committed = commitPingPong(next, fire, outcome);
    if (getTrade(trade.id)?.closed !== true) setTradePingPong(trade.id, committed);
    if (outcome === "skip" && !res.error) {
      log.info(`${label}: ping-pong ${fire.action} — tidak ada bin untuk dipindah, tunggu sinyal berikutnya`);
      continue;
    }
    notify(pingPongMessage(fresh, fire, res, outcome, committed));
  }
}

// Jalankan runPingPong di latar belakang. Satu run sekaligus: null bila run sebelumnya masih berjalan.
let running = null;
export function kickPingPong(positions, opts) {
  if (running) return null;
  running = runPingPong(positions, opts)
    .catch((err) => log.error(`Ping-pong error: ${err.message}`))
    .finally(() => {
      running = null;
    });
  return running;
}
