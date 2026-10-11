import test from "node:test";
import assert from "node:assert/strict";
import { aggregateTradePnl, evaluateTradeExit } from "../src/exit/trade-exit.js";

const allOn = (extra = {}) => ({
  id: 1,
  positions: ["a", "b"],
  exit: { tp: { on: true, pct: 15 }, sl: { on: true, pct: 25 }, trail: { on: true, startPct: 5, distancePct: 3 } },
  peakPnlPct: null,
  trailArmed: false,
  ...extra,
});

test("aggregate sums legs", () => {
  const map = new Map([
    ["a", { pnlUsd: 2, depositUsd: 50, pnlKnown: true }],
    ["b", { pnlUsd: 1, depositUsd: 50, pnlKnown: true }],
  ]);
  assert.deepEqual(aggregateTradePnl(allOn(), map), { pnlUsd: 3, depositUsd: 100, pnlPct: 3 });
});

test("aggregate unknown when a leg is not indexed", () => {
  const map = new Map([
    ["a", { pnlUsd: 2, depositUsd: 50, pnlKnown: true }],
    ["b", { pnlUsd: 1, depositUsd: 50 }],
  ]);
  assert.equal(aggregateTradePnl(allOn(), map), null);
});

test("aggregate unknown when a leg is missing from the map", () => {
  const map = new Map([["a", { pnlUsd: 2, depositUsd: 50, pnlKnown: true }]]);
  assert.equal(aggregateTradePnl(allOn(), map), null);
});

test("aggregate unknown when deposit total is not positive", () => {
  const map = new Map([
    ["a", { pnlUsd: 0, depositUsd: 0, pnlKnown: true }],
    ["b", { pnlUsd: 0, depositUsd: 0, pnlKnown: true }],
  ]);
  assert.equal(aggregateTradePnl(allOn(), map), null);
});

test("aggregate unknown when a leg value is not finite", () => {
  const map = new Map([
    ["a", { pnlUsd: NaN, depositUsd: 50, pnlKnown: true }],
    ["b", { pnlUsd: 1, depositUsd: 50, pnlKnown: true }],
  ]);
  assert.equal(aggregateTradePnl(allOn(), map), null);
});

test("null pnl never triggers", () => {
  const t = allOn({ peakPnlPct: 9, trailArmed: true });
  assert.deepEqual(evaluateTradeExit(t, null), { reason: null, peakPnlPct: 9, trailArmed: true });
});

test("tp at +15", () => {
  assert.equal(evaluateTradeExit(allOn(), 15).reason, "tp");
  assert.equal(evaluateTradeExit(allOn(), 14.99).reason, null);
});

test("sl at -25", () => {
  assert.equal(evaluateTradeExit(allOn(), -25).reason, "sl");
  assert.equal(evaluateTradeExit(allOn(), -24.99).reason, null);
});

test("trail example", () => {
  // TP dimatikan supaya jalur trail terlihat jelas.
  const t = allOn();
  t.exit.tp.on = false;
  const step = (pnl) => {
    const r = evaluateTradeExit(t, pnl);
    t.peakPnlPct = r.peakPnlPct;
    t.trailArmed = r.trailArmed;
    return r;
  };
  let r = step(4);
  assert.equal(r.reason, null);
  assert.equal(r.trailArmed, false);
  assert.equal(r.peakPnlPct, 4);
  r = step(6);
  assert.equal(r.reason, null);
  assert.equal(r.trailArmed, true);
  assert.equal(r.peakPnlPct, 6);
  r = step(18);
  assert.equal(r.peakPnlPct, 18);
  assert.equal(step(15.5).reason, null);
  assert.equal(step(15).reason, "trail");
});

test("off switches ignored", () => {
  const t = allOn();
  t.exit.tp.on = false;
  t.exit.sl.on = false;
  t.exit.trail.on = false;
  assert.equal(evaluateTradeExit(t, 500).reason, null);
  assert.equal(evaluateTradeExit(t, -90).reason, null);
});
