import test from "node:test";
import assert from "node:assert/strict";
import { aggregateTradePnl, evaluateTradeExit } from "../src/exit/trade-exit.js";
import { usdPnlFromEntry } from "../src/meteora/positions.js";

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

test("aggregate covers only legs still open (injected isClosed)", () => {
  const map = new Map([["b", { pnlUsd: -20, depositUsd: 50, pnlKnown: true }]]);
  const isClosed = (addr) => addr === "a";
  assert.deepEqual(aggregateTradePnl(allOn(), map, { isClosed }), { pnlUsd: -20, depositUsd: 50, pnlPct: -40 });
  // Semua leg tertutup -> tidak ada yang dievaluasi.
  assert.equal(aggregateTradePnl(allOn(), map, { isClosed: () => true }), null);
  // Leg terbuka yang tidak diketahui tetap membuat hasil null.
  assert.equal(aggregateTradePnl(allOn(), new Map(), { isClosed }), null);
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

test("aggregate unknown when one leg is known but has zero deposit", () => {
  const map = new Map([
    ["a", { pnlUsd: 2, depositUsd: 50, pnlKnown: true }],
    ["b", { pnlUsd: 0, depositUsd: 0, pnlKnown: true }],
  ]);
  assert.equal(aggregateTradePnl(allOn(), map), null);
});

test("usdPnlFromEntry: real values are known", () => {
  const r = usdPnlFromEntry({ pnlUsd: "-1.5", allTimeDeposits: { total: { usd: "50" } } });
  assert.deepEqual(r, { pnlUsd: -1.5, depositUsd: 50, pnlKnown: true });
  assert.equal(usdPnlFromEntry({ pnlUsd: 0, allTimeDeposits: { total: { usd: 50 } } }).pnlKnown, true);
});

test("usdPnlFromEntry: blank, missing or zero fields are not known", () => {
  const dep = { total: { usd: 50 } };
  assert.equal(usdPnlFromEntry({ pnlUsd: null, allTimeDeposits: dep }).pnlKnown, false);
  assert.equal(usdPnlFromEntry({ pnlUsd: "", allTimeDeposits: dep }).pnlKnown, false);
  assert.equal(usdPnlFromEntry({ allTimeDeposits: dep }).pnlKnown, false);
  assert.equal(usdPnlFromEntry({ pnlUsd: 1, allTimeDeposits: { total: { usd: 0 } } }).pnlKnown, false);
  assert.equal(usdPnlFromEntry({ pnlUsd: 1, allTimeDeposits: { total: { usd: "" } } }).pnlKnown, false);
  assert.equal(usdPnlFromEntry({ pnlUsd: 1, allTimeDeposits: { total: { usd: null } } }).pnlKnown, false);
  assert.equal(usdPnlFromEntry({ pnlUsd: 1 }).pnlKnown, false);
  assert.equal(usdPnlFromEntry(null).pnlKnown, false);
});

test("sl wins over tp when both conditions hold", () => {
  const t = allOn();
  t.exit.sl.pct = -20; // kondisi artifisial: pnl 15 memenuhi sl (<= 20) dan tp (>= 15)
  assert.equal(evaluateTradeExit(t, 15).reason, "sl");
});

test("non-finite previous peak is ignored", () => {
  const r = evaluateTradeExit(allOn({ peakPnlPct: NaN }), 2);
  assert.equal(r.peakPnlPct, 2);
});

test("flip leg deposit is excluded from the denominator", () => {
  const trade = allOn({ positions: ["A", "F"], flipLegs: ["F"] });
  const map = new Map([
    ["A", { pnlUsd: 10, depositUsd: 100, pnlKnown: true }],
    ["F", { pnlUsd: 2, depositUsd: 40, pnlKnown: true }],
  ]);
  assert.deepEqual(aggregateTradePnl(trade, map), { pnlUsd: 12, depositUsd: 100, pnlPct: 12 });
});

test("only flip legs open → their deposits are used", () => {
  const trade = allOn({ positions: ["A", "F"], flipLegs: ["F"] });
  const map = new Map([["F", { pnlUsd: 2, depositUsd: 40, pnlKnown: true }]]);
  assert.deepEqual(aggregateTradePnl(trade, map, { isClosed: (a) => a === "A" }), {
    pnlUsd: 2,
    depositUsd: 40,
    pnlPct: 5,
  });
});
