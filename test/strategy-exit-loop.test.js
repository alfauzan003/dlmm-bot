import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan semua file runtime ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-strategy-exit-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");
process.env.STRAT_FILE = path.join(TMP, "strat.conf");
process.env.PAPER_FILE = path.join(TMP, "paper-trades.json");
process.env.STRATEGY_LOG_FILE = path.join(TMP, "strategy-log.jsonl");
process.env.BACKTEST_DIR = path.join(TMP, "backtest");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { runStrategyExits } = await import("../src/exit/strategy-exit.js");
const { createTrade, getTrade, setTradeStrategyState, addTradeLeg, tryLockTrade, unlockTrade } = await import(
  "../src/state/trades.js"
);
const { trackPosition, recordClose } = await import("../src/state/positions.js");
const { setToggle } = await import("../src/state/settings.js");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test.beforeEach(() => {
  fs.rmSync(process.env.STATE_FILE, { force: true });
  fs.rmSync(process.env.SETTINGS_FILE, { force: true });
});

const EXIT = {
  tp: { on: false, pct: 15 },
  sl: { on: false, pct: 25 },
  trail: { on: false, startPct: 5, distancePct: 3 },
};
const PARAMS = { oorAboveMin: 10, oorBelowMin: 15, lowVolumeBars: 0, minVolume5mUsd: 0, maxHoldMin: 0 };
const RANGE = { below: 50, above: 0, lowerBin: 0, upperBin: 100, activeBin: 100 };

function newTrade({ params = PARAMS, strategy = true, range = RANGE, positions = ["L1"] } = {}) {
  return createTrade({
    pool: "PoolA",
    pair: "AAA-SOL",
    baseMint: "MintA",
    positions,
    shape: "bid_ask",
    range,
    origin: "auto",
    exit: EXIT,
    strategy: strategy ? { profile: "p", params, entry: {} } : null,
  });
}

const leg = (activeBin, over = {}) => ({
  position: "L1",
  pool: "PoolA",
  baseMint: "MintA",
  activeBin,
  lowerBin: 0,
  upperBin: 100,
  xIsSol: false,
  ...over,
});

function spyClose() {
  const calls = [];
  return {
    calls,
    closeTrade: async (trade, opts) => {
      calls.push({ id: trade.id, ...opts });
      return { success: true };
    },
  };
}

test("closes on range_broken once the timer persisted in state elapses (timer survives restart)", async () => {
  const trade = newTrade();
  setTradeStrategyState(trade.id, { aboveSince: null, belowSince: 0 });
  const spy = spyClose();
  const ids = await runStrategyExits([leg(-5)], { deps: { closeTrade: spy.closeTrade }, now: 15 * 60000 });
  assert.deepEqual(ids, [trade.id]);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].reason, "range_broken");
  assert.equal(spy.calls[0].swap, true);
  assert.ok(spy.calls[0].positionsByAddr.has("L1"));
});

test("first call stores the timer and does not close", async () => {
  const trade = newTrade();
  const spy = spyClose();
  const ids = await runStrategyExits([leg(-5)], { deps: { closeTrade: spy.closeTrade }, now: 1_000_000 });
  assert.deepEqual(ids, []);
  assert.equal(spy.calls.length, 0);
  assert.deepEqual(getTrade(trade.id).strategyState, { aboveSince: null, belowSince: 1_000_000 });
});

test("state is not written when nothing changed", async () => {
  const trade = newTrade();
  const spy = spyClose();
  await runStrategyExits([leg(50)], { deps: { closeTrade: spy.closeTrade }, now: 1000 });
  assert.equal(getTrade(trade.id).strategyState, undefined, "in range, nothing to persist");
});

test("runStrategyExits xIsSol leg", async () => {
  // SOL = X: bin lebih kecil = token lebih mahal; activeBin -5 < lowerBin => di atas range => pumped_away.
  const trade = newTrade();
  setTradeStrategyState(trade.id, { aboveSince: 0, belowSince: null });
  const spy = spyClose();
  await runStrategyExits([leg(-5, { xIsSol: true })], { deps: { closeTrade: spy.closeTrade }, now: 10 * 60000 });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].reason, "pumped_away");
});

test("cycle_done uses live flip legs", async () => {
  const trade = newTrade({ positions: ["L1"] });
  addTradeLeg(trade.id, "F", { flip: true });
  const spy = spyClose();
  const flip = { position: "F", pool: "PoolA", baseMint: "MintA", activeBin: 70, lowerBin: 40, upperBin: 60, xIsSol: false };
  await runStrategyExits([leg(70), flip], { deps: { closeTrade: spy.closeTrade }, now: 1000 });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].reason, "cycle_done");
});

test("volume_died reads closed 5m bars only", async () => {
  const now = 10_000_000;
  newTrade({ params: { ...PARAMS, lowVolumeBars: 2, minVolume5mUsd: 100 } });
  const fetched = [];
  const t0 = Math.floor(now / 1000);
  const fetchCandles = async (mint, pool, opts) => {
    fetched.push({ mint, pool, opts });
    return [
      { time: t0 - 900, volume: 5 },
      { time: t0 - 600, volume: 10 },
      { time: t0 - 300, volume: 20 },
      { time: t0 - 100, volume: 99999 }, // masih terbentuk => dibuang
    ];
  };
  const spy = spyClose();
  await runStrategyExits([leg(50)], { deps: { closeTrade: spy.closeTrade, fetchCandles }, now });
  assert.deepEqual(fetched, [{ mint: "MintA", pool: "PoolA", opts: { resolution: "5m", limit: 4 } }]);
  assert.equal(spy.calls[0]?.reason, "volume_died");
});

test("candle fetch failure does not throw and gives no volume exit", async () => {
  newTrade({ params: { ...PARAMS, lowVolumeBars: 2, minVolume5mUsd: 100 } });
  const spy = spyClose();
  const failing = [
    async () => null,
    async () => {
      throw new Error("boom");
    },
  ];
  for (const fetchCandles of failing) {
    const ids = await runStrategyExits([leg(50)], { deps: { closeTrade: spy.closeTrade, fetchCandles }, now: 10_000_000 });
    assert.deepEqual(ids, []);
  }
  assert.equal(spy.calls.length, 0);
});

test("no candle fetch when lowVolumeBars is 0", async () => {
  newTrade();
  let fetches = 0;
  const spy = spyClose();
  await runStrategyExits([leg(50)], {
    deps: {
      closeTrade: spy.closeTrade,
      fetchCandles: async () => {
        fetches++;
        return [];
      },
    },
    now: 1000,
  });
  assert.equal(fetches, 0);
});

test("skips locked trades, trades without strategy, and trades with no live leg", async () => {
  const spy = spyClose();
  const now = 15 * 60000;

  const locked = newTrade();
  setTradeStrategyState(locked.id, { aboveSince: null, belowSince: 0 });
  tryLockTrade(locked.id, "close");
  await runStrategyExits([leg(-5)], { deps: { closeTrade: spy.closeTrade }, now });
  unlockTrade(locked.id);
  assert.equal(spy.calls.length, 0, "locked");

  fs.rmSync(process.env.STATE_FILE, { force: true });
  newTrade({ strategy: false });
  await runStrategyExits([leg(-5)], { deps: { closeTrade: spy.closeTrade }, now });
  assert.equal(spy.calls.length, 0, "no strategy");

  fs.rmSync(process.env.STATE_FILE, { force: true });
  const t = newTrade();
  setTradeStrategyState(t.id, { aboveSince: null, belowSince: 0 });
  await runStrategyExits([leg(-5, { position: "OTHER" })], { deps: { closeTrade: spy.closeTrade }, now });
  await runStrategyExits([], { deps: { closeTrade: spy.closeTrade }, now });
  assert.equal(spy.calls.length, 0, "no live leg");
});

test("runs while Auto Entry is OFF", async () => {
  setToggle("autoEntry", false);
  const trade = newTrade();
  setTradeStrategyState(trade.id, { aboveSince: null, belowSince: 0 });
  const spy = spyClose();
  await runStrategyExits([leg(-5)], { deps: { closeTrade: spy.closeTrade }, now: 15 * 60000 });
  assert.equal(spy.calls.length, 1);
});

test("a failing trade does not stop the others", async () => {
  const a = newTrade();
  setTradeStrategyState(a.id, { aboveSince: null, belowSince: 0 });
  const b = newTrade({ positions: ["L2"] });
  setTradeStrategyState(b.id, { aboveSince: null, belowSince: 0 });
  const calls = [];
  const closeTrade = async (trade) => {
    calls.push(trade.id);
    if (trade.id === a.id) throw new Error("rpc down");
    return { success: true };
  };
  const ids = await runStrategyExits([leg(-5), leg(-5, { position: "L2" })], { deps: { closeTrade }, now: 15 * 60000 });
  assert.deepEqual(calls, [a.id, b.id]);
  assert.deepEqual(ids, [b.id]);
});

test("a live leg with unknown activeBin never closes and writes no state", async () => {
  const trade = newTrade();
  setTradeStrategyState(trade.id, { aboveSince: null, belowSince: 0 });
  const spy = spyClose();
  for (const activeBin of [null, undefined, NaN]) {
    await runStrategyExits([leg(activeBin)], { deps: { closeTrade: spy.closeTrade }, now: 60 * 60000 });
  }
  assert.equal(spy.calls.length, 0);
  assert.deepEqual(getTrade(trade.id).strategyState, { aboveSince: null, belowSince: 0 });
});

test("a flip leg with a null bound is ignored", async () => {
  const trade = newTrade();
  addTradeLeg(trade.id, "F", { flip: true });
  const spy = spyClose();
  const flip = { position: "F", pool: "PoolA", baseMint: "MintA", activeBin: 70, lowerBin: null, upperBin: 60, xIsSol: false };
  await runStrategyExits([leg(70), flip], { deps: { closeTrade: spy.closeTrade }, now: 1000 });
  assert.equal(spy.calls.length, 0, "no cycle_done from a half-known flip leg");
});

test("main leg selection ignores flip legs when a non-flip leg exists", async () => {
  const trade = newTrade();
  addTradeLeg(trade.id, "F", { flip: true });
  const spy = spyClose();
  // Flip leg di depan array dengan bin aktif di bawah range; leg utama masih di dalam range.
  const flip = { position: "F", pool: "PoolA", baseMint: "MintA", activeBin: -5, lowerBin: 40, upperBin: 60, xIsSol: false };
  await runStrategyExits([flip, leg(50)], { deps: { closeTrade: spy.closeTrade }, now: 60 * 60000 });
  assert.equal(spy.calls.length, 0);
  assert.equal(getTrade(trade.id).strategyState, undefined, "evaluated from the main leg (in range)");
});

test("legs closed in state are skipped; a trade whose only live leg is closed is not evaluated", async () => {
  const trade = newTrade();
  setTradeStrategyState(trade.id, { aboveSince: null, belowSince: 0 });
  trackPosition("L1", "PoolA", "AAA-SOL", "MintA", null, "bidask:double");
  recordClose("L1", "manual", 0);
  const spy = spyClose();
  await runStrategyExits([leg(-5)], { deps: { closeTrade: spy.closeTrade }, now: 15 * 60000 });
  assert.equal(spy.calls.length, 0);

  // Leg kedua yang masih terbuka dipakai; leg yang tertutup diabaikan.
  fs.rmSync(process.env.STATE_FILE, { force: true });
  const t2 = newTrade({ positions: ["L1", "L2"] });
  setTradeStrategyState(t2.id, { aboveSince: null, belowSince: 0 });
  trackPosition("L1", "PoolA", "AAA-SOL", "MintA", null, "bidask:double");
  recordClose("L1", "manual", 0);
  await runStrategyExits([leg(50), leg(-5, { position: "L2" })], { deps: { closeTrade: spy.closeTrade }, now: 15 * 60000 });
  assert.equal(spy.calls.length, 1, "closed L1 (in range) ignored, live L2 (below) drives the exit");
  assert.equal(spy.calls[0].reason, "range_broken");
});
