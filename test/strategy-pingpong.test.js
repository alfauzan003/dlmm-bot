import test from "node:test";
import assert from "node:assert/strict";
import { buildProfile } from "../src/strategy/params.js";
import {
  initialPingPong,
  ppRows,
  isSpike,
  chopCheck,
  stepPingPong,
  commitPingPong,
  samePingPong,
} from "../src/strategy/pingpong.js";

const P = buildProfile({}, "bidask_flip");
const T = (i) => i * 900;
// Baris siap pakai (lewati ppRows): default bearish, tanpa spike, chop OK.
const row = (i, o = {}) => ({
  time: T(i),
  high: 1.05,
  low: 0.95,
  close: 1,
  prevHigh: 1.05,
  direction: "bearish",
  line: 1.2,
  atr: 0.05,
  adx: 20,
  bbWidthPct: 25,
  spikeFloor: 1.1,
  volRatio: 1,
  ...o,
});

test("ppRows: Supertrend warm-up, spike floor = lowest low of lookback + mult x ATR, vol ratio", () => {
  const candles = Array.from({ length: 40 }, (_, i) => ({
    time: T(i),
    open: 1,
    high: 1.02 + (i % 3) * 0.01,
    low: 0.98 - (i % 2) * 0.01,
    close: 1 + (i % 2 ? 0.01 : -0.01),
    volume: i >= 36 ? 400 : 100,
  }));
  const rows = ppRows(candles, P);
  assert.equal(rows.length, 40);
  assert.equal(rows[19].direction, null); // 2 x ATR period 10
  assert.ok(["bullish", "bearish"].includes(rows[20].direction));
  const r = rows[39];
  const lowest = Math.min(...candles.slice(36, 40).map((c) => c.low));
  assert.ok(Math.abs(r.spikeFloor - (lowest + 2 * r.atr)) < 1e-12);
  assert.equal(r.prevHigh, candles[38].high);
  // 40 bar: 1h = 4 x 400, rata-rata per jam = (36 x 100 + 1600) / 10
  assert.ok(Math.abs(r.volRatio - 1600 / ((3600 + 1600) / 10)) < 1e-12);
  assert.equal(rows[14].volRatio, null); // < 16 bar
});

test("isSpike needs a bearish trend and close at or above the floor", () => {
  assert.equal(isSpike(row(1, { close: 1.1 })), true);
  assert.equal(isSpike(row(1, { close: 1.09 })), false);
  assert.equal(isSpike(row(1, { close: 1.2, direction: "bullish" })), false);
  assert.equal(isSpike(row(1, { close: 1.2, spikeFloor: null })), false);
});

test("chopCheck: each condition, 0 = off, unknown fails", () => {
  assert.equal(chopCheck(row(1), P).ok, true);
  assert.match(chopCheck(row(1, { bbWidthPct: 10 }), P).why, /BB width 10.0% < 15%/);
  assert.match(chopCheck(row(1, { adx: 35 }), P).why, /ADX 35.0 ≥ 35/);
  assert.match(chopCheck(row(1, { volRatio: 0.4 }), P).why, /1h volume 0.40x < 0.5x/);
  assert.equal(chopCheck(row(1, { volRatio: null }), P).ok, false);
  const off = { ...P, ppMinBbWidthPct: 0, ppMaxAdx: 0, ppMinVolRatio: 0 };
  assert.equal(chopCheck(row(1, { bbWidthPct: null, adx: null, volRatio: null }), off).ok, true);
});

test("first phase: the entry trend is read once; bearish leaves the pct auto flip alone", () => {
  const a = stepPingPong(undefined, [row(1), row(2)], P);
  assert.deepEqual(a.state, { ...initialPingPong(), entryTrend: "bearish", lastBar: T(2) });
  assert.equal(a.fire, null);
  const b = stepPingPong(a.state, [row(2), row(3)], P);
  assert.equal(b.fire, null);
  assert.equal(b.state.lastBar, T(3));
});

test("first phase, bullish entry: flip when a 15m bar closes below the Supertrend", () => {
  const a = stepPingPong(undefined, [row(1, { direction: "bullish" })], P);
  assert.equal(a.state.entryTrend, "bullish");
  const b = stepPingPong(a.state, [row(1, { direction: "bullish" }), row(2, { direction: "bullish" })], P);
  assert.equal(b.fire, null);
  const c = stepPingPong(b.state, [row(2, { direction: "bullish" }), row(3)], P);
  assert.equal(c.fire.action, "flip");
  assert.equal(c.fire.why, "st_break");
  assert.equal(c.state.lastBar, T(2), "fire bar not consumed");
  // Tidak ada token untuk di-flip -> skip, coba lagi bar bearish berikutnya.
  const skipped = commitPingPong(c.state, c.fire, "skip");
  assert.deepEqual([skipped.phase, skipped.lastBar], ["first", T(3)]);
  assert.equal(stepPingPong(skipped, [row(3), row(4)], P).fire.action, "flip");
  const done = commitPingPong(c.state, c.fire, "done");
  assert.deepEqual([done.phase, done.round, done.lastBar], ["ask", 1, T(3)]);
});

test("first → ask once the pct auto flip made a flip leg; never-evaluated state starts at the newest bar", () => {
  const s = stepPingPong({ ...initialPingPong(), entryTrend: "bearish" }, [], P, { flipped: true });
  assert.deepEqual([s.state.phase, s.state.round], ["ask", 1]);
  // Bar lama bullish tidak memicu drain bila belum pernah dievaluasi.
  const t = stepPingPong(undefined, [row(1, { direction: "bullish" }), row(2)], P, { flipped: true });
  assert.equal(t.state.phase, "ask");
  assert.equal(t.state.lastBar, T(2));
});

const ask = { ...initialPingPong(), phase: "ask", round: 1, entryTrend: "bearish", lastBar: T(1) };

test("ask: spike with chop → reverse (SOL back below the price)", () => {
  const r = stepPingPong(ask, [row(1), row(2, { close: 1.12 })], P);
  assert.equal(r.fire.action, "reverse");
  assert.equal(r.fire.price, 1.12);
  assert.match(r.fire.why, /spike: close 1.120 ≥ 1.100 \(low \+ 2 ATR\); BB width/);
  const s = commitPingPong(r.state, r.fire, "done");
  assert.deepEqual([s.phase, s.spikePrice, s.lowSince, s.lastBar, s.round], ["bid", 1.12, 1.12, T(2), 1]);
});

test("ask: spike without chop → drain", () => {
  const r = stepPingPong(ask, [row(2, { close: 1.12, adx: 40 })], P);
  assert.equal(r.fire, null);
  assert.equal(r.state.phase, "drain");
  assert.equal(r.drained.reason, "weak");
  assert.match(r.drained.detail, /chop gone: ADX 40.0 ≥ 35/);
});

test("ask: all tokens sold at the bar close also decides; old spikes do not act", () => {
  assert.equal(stepPingPong(ask, [row(2)], P, { allSold: true }).fire.action, "reverse");
  const old = stepPingPong(ask, [row(2, { close: 1.12 }), row(3)], P);
  assert.equal(old.fire, null);
  assert.equal(old.state.lastBar, T(3));
});

test("ask / bid: Supertrend turning bullish → drain", () => {
  const r = stepPingPong(ask, [row(2, { direction: "bullish", close: 1.3 })], P);
  assert.deepEqual([r.state.phase, r.drained.reason], ["drain", "trend_up"]);
  const bid = { ...ask, phase: "bid", spikePrice: 1, lowSince: 1 };
  assert.equal(stepPingPong(bid, [row(2, { direction: "bullish" })], P).state.phase, "drain");
});

test("bid: flip up only after a dip of at least the min % and a close above the previous high", () => {
  const bid = { ...ask, phase: "bid", spikePrice: 1, lowSince: 1 };
  // Turun 4% saja: belum.
  const a = stepPingPong(bid, [row(2, { low: 0.96, close: 1.1, prevHigh: 1.05 })], P);
  assert.equal(a.fire, null);
  assert.equal(a.state.lowSince, 0.96);
  // Turun 6%, tapi tutup belum di atas high sebelumnya.
  const b = stepPingPong(a.state, [row(3, { low: 0.94, close: 0.97, prevHigh: 0.98 })], P);
  assert.equal(b.fire, null);
  assert.equal(b.state.lowSince, 0.94);
  const c = stepPingPong(b.state, [row(4, { low: 0.95, close: 0.99, prevHigh: 0.98 })], P);
  assert.equal(c.fire.action, "flip");
  assert.match(c.fire.why, /dipped 6.0% from the spike/);
  const s = commitPingPong(c.state, c.fire, "done");
  assert.deepEqual([s.phase, s.round, s.spikePrice, s.lowSince], ["ask", 2, null, null]);
});

test("drain is final; stuck actions drain", () => {
  const d = { ...ask, phase: "drain" };
  assert.deepEqual(stepPingPong(d, [row(2, { close: 2 })], P), { state: d, fire: null, drained: null });
  const fire = { action: "reverse", time: T(2), price: 1 };
  assert.equal(commitPingPong(ask, fire, "stuck").phase, "drain");
});

test("samePingPong ignores missing defaults", () => {
  assert.equal(samePingPong(undefined, initialPingPong()), true);
  assert.equal(samePingPong({ phase: "ask" }, initialPingPong()), false);
});
