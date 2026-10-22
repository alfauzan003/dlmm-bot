import test from "node:test";
import assert from "node:assert/strict";
import { closedBars, livePandaSignal, liveRow, pandaExitDetail, pandaRows, stepPanda } from "../src/exit/evil-panda.js";

const BAR = 900;
const PARAMS = {
  stAtrPeriod: 10,
  stMultiplier: 3,
  rsi: { on: true, length: 2, level: 90 },
  macd: { on: false, fast: 12, slow: 26, signal: 9 },
  bb: { on: false, length: 20, stdDev: 2 },
};
const withSignals = (over) => ({ ...PARAMS, ...over });

function row(t, direction, extra = {}) {
  return { time: t * BAR, close: 1, direction, rsi: null, hist: null, prevHist: null, upper: null, ...extra };
}

const step = (rows, { progress, params = PARAMS, openedAtSec = 0 } = {}) =>
  stepPanda(progress, rows, params, { openedAtSec });

test("bearish start never arms", () => {
  const r = step([row(1, "bearish", { rsi: 95 }), row(2, "bearish", { rsi: 95 }), row(3, "bearish", { rsi: 95 })]);
  assert.equal(r.fire, null);
  assert.equal(r.progress.armed, false);
  assert.equal(r.progress.seenAbove, false);
  assert.equal(r.progress.lastBar, 3 * BAR);
});

test("a break below the Supertrend after seeing price above arms", () => {
  const r = step([row(1, "bullish"), row(2, "bearish", { rsi: 50 })]);
  assert.equal(r.fire, null);
  assert.deepEqual(r.progress, { seenAbove: true, armed: true, lastBar: 2 * BAR });
});

test("armed + RSI spike fires and leaves lastBar before the firing bar", () => {
  const r = step([row(1, "bullish"), row(2, "bearish"), row(3, "bearish", { rsi: 95 })]);
  assert.deepEqual(r.fire, { signal: "rsi", time: 3 * BAR });
  assert.equal(r.progress.lastBar, 2 * BAR);
  assert.equal(r.progress.armed, true);
});

test("a bar back above the Supertrend disarms and does not fire", () => {
  const r = step([row(1, "bullish"), row(2, "bearish"), row(3, "bullish", { rsi: 99 })]);
  assert.equal(r.fire, null);
  assert.equal(r.progress.armed, false);
  assert.equal(r.progress.seenAbove, true);
});

test("MACD fires only on the first green histogram bar", () => {
  const params = withSignals({ rsi: { ...PARAMS.rsi, on: false }, macd: { ...PARAMS.macd, on: true } });
  const armed = [row(1, "bullish"), row(2, "bearish")];
  const still = step([...armed, row(3, "bearish", { hist: 0.2, prevHist: 0.1 })], { params });
  assert.equal(still.fire, null);
  const first = step([...armed, row(3, "bearish", { hist: 0.1, prevHist: -0.2 })], { params });
  assert.equal(first.fire.signal, "macd");
});

test("BB fires on a close above the upper band", () => {
  const params = withSignals({ rsi: { ...PARAMS.rsi, on: false }, bb: { ...PARAMS.bb, on: true } });
  const r = step([row(1, "bullish"), row(2, "bearish"), row(3, "bearish", { close: 2, upper: 1.5 })], { params });
  assert.equal(r.fire.signal, "bb");
  const under = step([row(1, "bullish"), row(2, "bearish"), row(3, "bearish", { close: 1, upper: 1.5 })], { params });
  assert.equal(under.fire, null);
});

test("a switched-off signal is ignored", () => {
  const params = withSignals({ rsi: { ...PARAMS.rsi, on: false } });
  const r = step([row(1, "bullish"), row(2, "bearish"), row(3, "bearish", { rsi: 99 })], { params });
  assert.equal(r.fire, null);
});

test("signals are checked RSI, MACD, BB", () => {
  const params = withSignals({ macd: { ...PARAMS.macd, on: true }, bb: { ...PARAMS.bb, on: true } });
  const spike = { rsi: 95, hist: 1, prevHist: -1, close: 2, upper: 1 };
  assert.equal(step([row(1, "bullish"), row(2, "bearish"), row(3, "bearish", spike)], { params }).fire.signal, "rsi");
  const noRsi = { ...spike, rsi: 10 };
  assert.equal(step([row(1, "bullish"), row(2, "bearish"), row(3, "bearish", noRsi)], { params }).fire.signal, "macd");
});

test("bars before the trade opened are ignored", () => {
  const r = step([row(1, "bullish"), row(2, "bullish"), row(3, "bearish")], { openedAtSec: 3 * BAR + 10 });
  assert.equal(r.progress.seenAbove, false);
  assert.equal(r.progress.armed, false);
});

test("a bar with unknown direction keeps the state and advances lastBar", () => {
  const r = step([row(1, "bullish"), row(2, null, { rsi: 99 }), row(3, "bearish")]);
  assert.deepEqual(r.progress, { seenAbove: true, armed: true, lastBar: 3 * BAR });
});

test("replay starts after lastBar", () => {
  const progress = { seenAbove: false, armed: false, lastBar: 2 * BAR };
  const r = step([row(1, "bullish"), row(2, "bullish"), row(3, "bearish")], { progress });
  assert.equal(r.progress.armed, false);
  assert.equal(r.progress.lastBar, 3 * BAR);
});

test("stepPanda does not mutate its input progress", () => {
  const progress = { seenAbove: false, armed: false, lastBar: null };
  step([row(1, "bullish"), row(2, "bearish")], { progress });
  assert.deepEqual(progress, { seenAbove: false, armed: false, lastBar: null });
});

function candles(n, startBar = 0) {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + 10 * Math.sin(i / 3);
    return { time: (startBar + i) * BAR, open: close, high: close + 1, low: close - 1, close, volume: 1 };
  });
}

test("pandaRows treats the first 2 * ATR period bars as warm-up", () => {
  const rows = pandaRows(candles(60), withSignals({ macd: { ...PARAMS.macd, on: true } }));
  assert.equal(rows.length, 60);
  assert.equal(rows[19].direction, null);
  assert.ok(["bullish", "bearish"].includes(rows[20].direction));
  assert.equal(rows[59].time, 59 * BAR);
  assert.ok(Number.isFinite(rows[59].rsi));
  assert.ok(Number.isFinite(rows[59].hist) && Number.isFinite(rows[59].prevHist));
  assert.ok(Number.isFinite(rows[59].upper));
});

test("pandaRows leaves MACD empty when slow <= fast", () => {
  const rows = pandaRows(candles(60), withSignals({ macd: { on: true, fast: 26, slow: 12, signal: 9 } }));
  assert.equal(rows[59].hist, null);
  assert.equal(rows[59].prevHist, null);
});

test("closedBars drops the forming bar and waits for the latest closed bar", () => {
  const nowMs = (100 * BAR + 5) * 1000;
  const list = candles(4, 97); // bars 97..100, 100 still forming
  assert.deepEqual(
    closedBars(list, nowMs).map((c) => c.time / BAR),
    [97, 98, 99]
  );
  assert.equal(closedBars(candles(2, 97), nowMs), null); // bar 99 missing
  assert.equal(closedBars([], nowMs), null);
});

test("the breaking bar itself can fire (arm, then check signals)", () => {
  const r = step([row(1, "bullish"), row(2, "bearish", { rsi: 95 })]);
  assert.deepEqual(r.fire, { signal: "rsi", time: 2 * BAR });
  assert.equal(r.progress.lastBar, 1 * BAR);
});

test("a spike on an older bar does not fire (only the latest closed bar can)", () => {
  const r = step([
    row(1, "bullish"),
    row(2, "bearish"),
    row(3, "bearish", { rsi: 95 }),
    row(4, "bearish", { rsi: 50 }),
  ]);
  assert.equal(r.fire, null);
  assert.deepEqual(r.progress, { seenAbove: true, armed: true, lastBar: 4 * BAR });
});

test("liveRow appends the live price as the forming bar", () => {
  const closed = candles(60);
  const live = liveRow(closed, 123, PARAMS);
  assert.equal(live.time, 60 * BAR);
  assert.equal(live.close, 123);
  assert.ok(Number.isFinite(live.rsi));
  assert.ok(["bullish", "bearish"].includes(live.direction));
});

test("livePandaSignal fires only while armed and still below the Supertrend", () => {
  const armed = { seenAbove: true, armed: true, lastBar: 2 * BAR };
  const spike = row(3, "bearish", { rsi: 95 });
  assert.equal(livePandaSignal(armed, spike, PARAMS), "rsi");
  assert.equal(livePandaSignal({ ...armed, armed: false }, spike, PARAMS), null);
  assert.equal(livePandaSignal(undefined, spike, PARAMS), null);
  assert.equal(livePandaSignal(armed, row(3, "bullish", { rsi: 99 }), PARAMS), null);
  assert.equal(livePandaSignal(armed, row(3, "bearish", { rsi: 50 }), PARAMS), null);
});

test("pandaExitDetail names the source, the spike and the threshold", () => {
  assert.equal(
    pandaExitDetail({ signal: "rsi", time: 0 }, row(0, "bearish", { rsi: 93.456 }), PARAMS),
    "closed 15m bar: RSI 93.5 > 90 while armed (price broke below 15m Supertrend)"
  );
  assert.equal(
    pandaExitDetail({ signal: "macd", time: 0, price: 0.000012346 }, row(0, "bearish", { prevHist: -0.5, hist: 0.25 }), PARAMS),
    "live price 0.00001235: MACD histogram turned positive (-0.5 → 0.25) while armed (price broke below 15m Supertrend)"
  );
  assert.match(pandaExitDetail({ signal: "bb", time: 0 }, row(0, "bearish", { close: 1.2, upper: 1.1 }), PARAMS), /^closed 15m bar: close 1\.2 > upper Bollinger 1\.1/);
  assert.match(pandaExitDetail({ signal: "rsi", time: 0 }, null, PARAMS), /RSI \? > 90/);
});
