import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan semua file runtime ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-pingpong-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");
process.env.STRAT_FILE = path.join(TMP, "strat.conf");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { runPingPong, allLegsSold, pingPongMessage, __resetPingPongThrottle } = await import("../src/exit/pingpong.js");
const { createTrade, getTrade, addTradeLeg, setTradePingPong, tryLockTrade, unlockTrade } = await import(
  "../src/state/trades.js"
);
const { trackPosition } = await import("../src/state/positions.js");
const { buildProfile } = await import("../src/strategy/params.js");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test.beforeEach(() => {
  fs.rmSync(process.env.STATE_FILE, { force: true });
  __resetPingPongThrottle();
});

const P = buildProfile({}, "bidask_flip");
const BAR = 900;
const NOW = 100 * BAR * 1000 + 10_000; // bar tutup terbaru = 99
const T = (i) => i * BAR;

function newTrade({ params = P, autoFlip = { pct: 65 } } = {}) {
  trackPosition("L1", "PoolA", "AAA-SOL", "MintA", null, "bidask:sol");
  return createTrade({
    pool: "PoolA",
    pair: "AAA-SOL",
    baseMint: "MintA",
    positions: ["L1"],
    shape: "bid_ask",
    range: { below: 50, above: 0, lowerBin: 0, upperBin: 100, activeBin: 100 },
    origin: "auto",
    exit: { tp: { on: false }, sl: { on: false }, trail: { on: false } },
    autoFlip,
    strategy: { profile: "bidask_flip", params, entry: {} },
  });
}

const live = (activeBin = 90, extra = []) => [
  { position: "L1", activeBin, lowerBin: 0, upperBin: 100, xIsSol: false },
  ...extra,
];
// Candle 15m sampai bar 100 (masih terbentuk); isinya tidak dipakai karena ppRows di-mock.
const candles = Array.from({ length: 61 }, (_, i) => ({ time: T(40 + i), open: 1, high: 1, low: 1, close: 1, volume: 1 }));
const row = (i, o = {}) => ({
  time: T(i),
  high: 1.05,
  low: 0.95,
  close: 1,
  prevHigh: 1.05,
  direction: "bearish",
  atr: 0.05,
  adx: 20,
  bbWidthPct: 25,
  spikeFloor: 1.1,
  volRatio: 1,
  ...o,
});

function deps(rows, { flipRes = { success: true, binCount: 8, tokenAmount: 0.4 } } = {}) {
  const calls = { fetch: 0, flips: [], notes: [] };
  return {
    calls,
    deps: {
      fetchCandles: async () => {
        calls.fetch++;
        return candles;
      },
      ppRows: () => rows,
      flipTrade: async (trade, opts) => {
        calls.flips.push(opts.side);
        return flipRes;
      },
      notify: (text) => calls.notes.push(text),
    },
  };
}

const ASK = { phase: "ask", entryTrend: "bearish", round: 1, lastBar: T(98), spikePrice: null, lowSince: null };

test("non ping-pong trades are skipped", async () => {
  newTrade({ params: { ...P, flipMode: "pct" } });
  const { deps: d, calls } = deps([row(99)]);
  await runPingPong(live(), { deps: d, now: NOW });
  assert.equal(calls.fetch, 0);
});

test("bullish entry: pct auto flip off, then flip on the Supertrend break", async () => {
  const t = newTrade();
  const a = deps([row(98, { direction: "bullish" }), row(99, { direction: "bullish" })]);
  await runPingPong(live(), { deps: a.deps, now: NOW });
  let fresh = getTrade(t.id);
  assert.equal(fresh.autoFlip, undefined);
  assert.deepEqual([fresh.pingpong.phase, fresh.pingpong.entryTrend, fresh.pingpong.lastBar], ["first", "bullish", T(99)]);
  assert.match(a.calls.notes[0], /bullish at entry/);

  const b = deps([row(99, { direction: "bullish" }), row(100)]);
  await runPingPong(live(), { deps: b.deps, now: NOW + BAR * 1000 });
  assert.deepEqual(b.calls.flips, ["token"]);
  fresh = getTrade(t.id);
  assert.deepEqual([fresh.pingpong.phase, fresh.pingpong.round, fresh.pingpong.lastBar], ["ask", 1, T(100)]);
  assert.match(b.calls.notes[0], /flipped 8 bins .* round 1/);
});

test("bearish entry keeps the pct auto flip; after it flips the trade goes to ask without candles", async () => {
  const t = newTrade();
  const a = deps([row(99)]);
  await runPingPong(live(), { deps: a.deps, now: NOW });
  assert.deepEqual(getTrade(t.id).autoFlip, { pct: 65 });
  assert.equal(getTrade(t.id).pingpong.entryTrend, "bearish");

  addTradeLeg(t.id, "F", { flip: true });
  const b = deps([row(99)]);
  await runPingPong(live(90, [{ position: "F", activeBin: 90, lowerBin: 91, upperBin: 120 }]), {
    deps: b.deps,
    now: NOW + 5000,
  });
  assert.equal(b.calls.fetch, 0, "same bar: no candle fetch");
  assert.equal(getTrade(t.id).pingpong.phase, "ask");
  assert.equal(getTrade(t.id).autoFlip, undefined);
});

test("ask: spike with chop moves SOL below; busy keeps the bar for the next tick", async () => {
  const t = newTrade({ autoFlip: null });
  addTradeLeg(t.id, "F", { flip: true });
  setTradePingPong(t.id, ASK);
  const legs = live(90, [{ position: "F", activeBin: 90, lowerBin: 85, upperBin: 120 }]);

  const busy = deps([row(98), row(99, { close: 1.2 })], { flipRes: { success: false, busy: true, binCount: 0 } });
  await runPingPong(legs, { deps: busy.deps, now: NOW });
  assert.equal(getTrade(t.id).pingpong.lastBar, T(98));
  assert.equal(busy.calls.notes.length, 0);

  const ok = deps([row(98), row(99, { close: 1.2 })]);
  await runPingPong(legs, { deps: ok.deps, now: NOW + 5000 });
  assert.deepEqual(ok.calls.flips, ["sol"]);
  const pp = getTrade(t.id).pingpong;
  assert.deepEqual([pp.phase, pp.spikePrice, pp.lowSince, pp.lastBar], ["bid", 1.2, 1.2, T(99)]);
  assert.match(ok.calls.notes[0], /moved 0.4 SOL from 8 sold bins back below the price/);
});

test("ask: spike without chop drains; a failed re-deposit drains too", async () => {
  const t = newTrade({ autoFlip: null });
  addTradeLeg(t.id, "F", { flip: true });
  setTradePingPong(t.id, ASK);
  const weak = deps([row(99, { close: 1.2, bbWidthPct: 5 })]);
  await runPingPong(live(), { deps: weak.deps, now: NOW });
  assert.deepEqual([getTrade(t.id).pingpong.phase, getTrade(t.id).pingpong.drainReason], ["drain", "weak"]);
  assert.equal(weak.calls.flips.length, 0);
  assert.match(weak.calls.notes[0], /ends: .*BB width 5.0% < 15%.*sold now \(drain_weak\)/);

  setTradePingPong(t.id, ASK);
  const stuck = deps([row(99, { close: 1.2 })], { flipRes: { success: false, redepositFailed: true, binCount: 8 } });
  await runPingPong(live(), { deps: stuck.deps, now: NOW });
  assert.equal(getTrade(t.id).pingpong.phase, "drain");
  assert.match(stuck.calls.notes[0], /No more ping-pong/);
});

test("bid: flip up after the dip and a reversal bar; nothing to flip waits quietly", async () => {
  const t = newTrade({ autoFlip: null });
  addTradeLeg(t.id, "F", { flip: true });
  setTradePingPong(t.id, { ...ASK, phase: "bid", spikePrice: 1, lowSince: 0.93 });
  const none = deps([row(99, { low: 0.95, close: 1, prevHigh: 0.98 })], { flipRes: { success: false, binCount: 0 } });
  await runPingPong(live(), { deps: none.deps, now: NOW });
  assert.deepEqual(none.calls.flips, ["token"]);
  assert.equal(none.calls.notes.length, 0);
  const pp = getTrade(t.id).pingpong;
  assert.deepEqual([pp.phase, pp.lastBar], ["bid", T(99)]);
});

test("locked trades and drained trades are skipped", async () => {
  const t = newTrade();
  tryLockTrade(t.id, "close");
  const a = deps([row(99)]);
  await runPingPong(live(), { deps: a.deps, now: NOW });
  assert.equal(a.calls.fetch, 0);
  unlockTrade(t.id);
  setTradePingPong(t.id, { phase: "drain" });
  await runPingPong(live(), { deps: a.deps, now: NOW });
  assert.equal(a.calls.fetch, 0);
  setTradePingPong(t.id, { phase: "drain", drainReason: "weak" });
  await runPingPong(live(), { deps: a.deps, now: NOW });
  assert.equal(a.calls.fetch, 0);
});

test("weak drain with the drain exit off keeps the old message", async () => {
  const t = newTrade({ params: { ...P, drainExit: false }, autoFlip: null });
  addTradeLeg(t.id, "F", { flip: true });
  setTradePingPong(t.id, ASK);
  const weak = deps([row(99, { close: 1.2, bbWidthPct: 5 })]);
  await runPingPong(live(), { deps: weak.deps, now: NOW });
  assert.match(weak.calls.notes[0], /The tokens sell out, then the trade closes \(trend_done\)\.$/);
});

test("drain after trend_up keeps watching 15m bars until the trend fails", async () => {
  const t = newTrade({ autoFlip: null });
  addTradeLeg(t.id, "F", { flip: true });
  setTradePingPong(t.id, { ...ASK, phase: "drain", drainReason: "trend_up", lastBar: T(98) });
  const a = deps([row(98, { direction: "bullish" }), row(99, { close: 0.8 })]);
  await runPingPong(live(), { deps: a.deps, now: NOW });
  assert.equal(a.calls.fetch, 1);
  assert.deepEqual(getTrade(t.id).pingpong.trendFailed, { time: T(99), price: 0.8 });
  assert.equal(a.calls.flips.length, 0);
  // Sudah gagal: tidak di-fetch lagi (exit strategi yang menutup).
  __resetPingPongThrottle();
  const b = deps([row(99)]);
  await runPingPong(live(), { deps: b.deps, now: NOW + BAR * 1000 });
  assert.equal(b.calls.fetch, 0);
});

test("trend_up drain message mentions trend_failed", async () => {
  const t = newTrade({ autoFlip: null });
  addTradeLeg(t.id, "F", { flip: true });
  setTradePingPong(t.id, ASK);
  const up = deps([row(99, { direction: "bullish" })]);
  await runPingPong(live(), { deps: up.deps, now: NOW });
  assert.equal(getTrade(t.id).pingpong.drainReason, "trend_up");
  assert.match(up.calls.notes[0], /trend_done.*closes back below the Supertrend \(trend_failed\)/);
});

test("allLegsSold: price above every open leg", () => {
  const t = { positions: ["L1", "F"] };
  const m = (active) =>
    new Map([
      ["L1", { activeBin: active, lowerBin: 0, upperBin: 100, xIsSol: false }],
      ["F", { activeBin: active, lowerBin: 101, upperBin: 130, xIsSol: false }],
    ]);
  assert.equal(allLegsSold(t, m(130)), false);
  assert.equal(allLegsSold(t, m(131)), true);
  assert.equal(allLegsSold(t, new Map()), false);
});

test("pingPongMessage dry run", () => {
  const msg = pingPongMessage(
    { id: 3, pair: "AAA-SOL" },
    { action: "reverse", why: "spike" },
    { dryRun: true, binCount: 4 },
    "done",
    {}
  );
  assert.match(msg, /DRY RUN — 🏓 Ping-pong #3 AAA-SOL would move the SOL of 4 sold bins back below the price \(spike\)/);
});
