import test from "node:test";
import assert from "node:assert/strict";
import { buildProfile } from "../src/strategy/params.js";
import { STRATEGY_EXIT_REASONS, tokenPos, evaluateStrategyExit, strategyExitDetail } from "../src/strategy/exits.js";

const P = { ...buildProfile({}, "bidask_flip"), oorAboveMin: 10, oorBelowMin: 15, lowVolumeBars: 3, minVolume5mUsd: 1000, maxHoldMin: 120 };
const T = (o = {}) => ({ range: { lowerBin: -50, upperBin: 0 }, openedAt: 0, ...o });
const V = (o = {}) => ({ activeBin: -10, xIsSol: false, flipLegs: [], volumes: [5000, 5000, 5000], ...o });
const M = 60_000;

test("reasons list and tokenPos", () => {
  assert.deepEqual(STRATEGY_EXIT_REASONS, [
    "cycle_done",
    "trend_done",
    "drain_weak",
    "trend_failed",
    "pumped_away",
    "range_broken",
    "volume_died",
    "max_hold",
  ]);
  assert.equal(tokenPos(5, false), 5);
  assert.equal(tokenPos(5, true), -5);
});

test("in range: no reason, timers null", () => {
  assert.deepEqual(evaluateStrategyExit({ trade: T(), view: V(), p: P, now: M }), { reason: null, state: { aboveSince: null, belowSince: null } });
});

test("pumped_away after oorAboveMin", () => {
  const first = evaluateStrategyExit({ trade: T(), view: V({ activeBin: 3 }), p: P, now: 5 * M });
  assert.deepEqual(first, { reason: null, state: { aboveSince: 5 * M, belowSince: null } });
  const t = T({ strategyState: first.state });
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: 3 }), p: P, now: 15 * M }).reason, "pumped_away");
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: -1 }), p: P, now: 15 * M }).state.aboveSince, null);
});

test("range_broken after oorBelowMin", () => {
  const t = T({ strategyState: { aboveSince: null, belowSince: 0 } });
  const view = V({ activeBin: -51 });
  assert.equal(evaluateStrategyExit({ trade: t, view, p: P, now: 15 * M }).reason, "range_broken");
  const early = evaluateStrategyExit({ trade: t, view, p: P, now: 14 * M });
  assert.equal(early.reason, null);
  assert.equal(early.state.belowSince, 0);
});

test("cycle_done only when flipped and above every flip leg", () => {
  const t = T({ flipLegs: ["L1"] });
  const legs = [{ lowerBin: -29, upperBin: -1 }];
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: -1, flipLegs: legs }), p: P, now: M }).reason, null);
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: 0, flipLegs: legs }), p: P, now: M }).reason, "cycle_done");
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: 3, flipLegs: legs }), p: P, now: 30 * M }).reason, "cycle_done");
});

test("flipped trade above SOL range never starts the pumped_away timer", () => {
  const r = evaluateStrategyExit({ trade: T({ flipLegs: ["L1"] }), view: V({ activeBin: 3, flipLegs: [] }), p: P, now: M });
  assert.equal(r.state.aboveSince, null);
});

test("exits xIsSol: bins run the other way", () => {
  const t = T({ range: { lowerBin: 0, upperBin: 50 } }); // token price falls as bin id rises
  const above = evaluateStrategyExit({ trade: t, view: V({ activeBin: -3, xIsSol: true }), p: P, now: M });
  assert.equal(above.state.aboveSince, M);
  const below = evaluateStrategyExit({ trade: t, view: V({ activeBin: 51, xIsSol: true }), p: P, now: M });
  assert.equal(below.state.belowSince, M);
});

test("volume_died needs lowVolumeBars low bars; disabled at 0", () => {
  assert.equal(evaluateStrategyExit({ trade: T(), view: V({ volumes: [5000, 900, 900, 900] }), p: P, now: M }).reason, "volume_died");
  assert.equal(evaluateStrategyExit({ trade: T(), view: V({ volumes: [900, 900] }), p: P, now: M }).reason, null);
  assert.equal(evaluateStrategyExit({ trade: T(), view: V({ volumes: [1, 1, 1] }), p: { ...P, lowVolumeBars: 0 }, now: M }).reason, null);
});

test("max_hold and first-match order", () => {
  assert.equal(evaluateStrategyExit({ trade: T(), view: V(), p: P, now: 120 * M }).reason, "max_hold");
  const both = evaluateStrategyExit({ trade: T({ strategyState: { aboveSince: 0, belowSince: null } }),
    view: V({ activeBin: 3, volumes: [1, 1, 1] }), p: P, now: 120 * M });
  assert.equal(both.reason, "pumped_away");
});

test("OOR timers at 0 are off (never pumped_away / range_broken)", () => {
  const off = { ...P, oorAboveMin: 0, oorBelowMin: 0, maxHoldMin: 0 };
  const above = T({ strategyState: { aboveSince: 0, belowSince: null } });
  assert.equal(evaluateStrategyExit({ trade: above, view: V({ activeBin: 3 }), p: off, now: 60 * M }).reason, null);
  const below = T({ strategyState: { aboveSince: null, belowSince: 0 } });
  assert.equal(evaluateStrategyExit({ trade: below, view: V({ activeBin: -51 }), p: off, now: 60 * M }).reason, null);
  // timer tetap dicatat (state) walau exit-nya off
  assert.equal(evaluateStrategyExit({ trade: T(), view: V({ activeBin: 3 }), p: off, now: M }).state.aboveSince, M);
});

test("strategyExitDetail explains each strategy exit", () => {
  const d = (reason, o = {}) => strategyExitDetail(reason, { trade: T(), view: V(), p: P, now: 20 * M, state: {}, ...o });
  assert.match(d("cycle_done"), /above the flip range/);
  assert.equal(d("pumped_away", { state: { aboveSince: 9 * M } }), "price above range (no dip, SOL unused) for 11m ≥ 10m");
  assert.equal(d("range_broken", { state: { belowSince: 4 * M } }), "price below range for 16m ≥ 15m");
  assert.equal(d("volume_died", { view: V({ volumes: [420.4, 310, 150] }) }), "last 3 5m bars $420 / $310 / $150 < $1000");
  assert.equal(d("max_hold", { now: 121 * M }), "held 121m ≥ 120m");
  assert.equal(d(null), null);
});

// --- Ping-pong (trade.pingpong ada) ---
const PP = { ...P, flipMode: "pingpong" };
const PPT = (phase, o = {}) => T({ flipLegs: ["F"], pingpong: { phase }, ...o });

test("ping-pong: no cycle_done; trend_done only in drain above every leg", () => {
  const legs = [{ lowerBin: 1, upperBin: 30 }];
  const above = V({ activeBin: 31, flipLegs: legs });
  assert.equal(evaluateStrategyExit({ trade: PPT("ask"), view: above, p: PP, now: M }).reason, null);
  assert.equal(evaluateStrategyExit({ trade: PPT("drain"), view: above, p: PP, now: M }).reason, "trend_done");
  assert.equal(evaluateStrategyExit({ trade: PPT("drain"), view: V({ activeBin: 30, flipLegs: legs }), p: PP, now: M }).reason, null);
  assert.match(strategyExitDetail("trend_done", {}), /ping-pong ended/);
});

test("ping-pong without state (paper / not evaluated yet) keeps the pct exits", () => {
  const t = T({ flipLegs: ["F"] });
  const legs = [{ lowerBin: 1, upperBin: 30 }];
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: 31, flipLegs: legs }), p: PP, now: M }).reason, "cycle_done");
});

test("ping-pong bid: pumped_away once the price is above every leg and the turn point for oorAboveMin", () => {
  // Leg SOL terakhir 10..19 (titik balik = bin 20), token leg flip lama 1..9.
  const view = (activeBin) =>
    V({ activeBin, flipLegs: [{ lowerBin: 1, upperBin: 9 }, { lowerBin: 10, upperBin: 19 }], solLegs: [{ lowerBin: 10, upperBin: 19 }] });
  const atTurn = evaluateStrategyExit({ trade: PPT("bid"), view: view(20), p: PP, now: M });
  assert.equal(atTurn.state.aboveSince, null);
  const first = evaluateStrategyExit({ trade: PPT("bid"), view: view(21), p: PP, now: M });
  assert.equal(first.state.aboveSince, M);
  const t = PPT("bid", { strategyState: first.state });
  const r = evaluateStrategyExit({ trade: t, view: view(21), p: PP, now: 11 * M });
  assert.equal(r.reason, "pumped_away");
  assert.match(strategyExitDetail("pumped_away", { trade: t, p: PP, now: 11 * M, state: r.state }), /ping-pong SOL legs/);
  // Fase ask di atas semua leg: tidak ada timer (keputusan saat bar 15m tutup).
  assert.equal(evaluateStrategyExit({ trade: PPT("ask"), view: view(25), p: PP, now: M }).state.aboveSince, null);
});

test("ping-pong drain exit: weak drain closes at once, trend_up drain closes once the trend failed", () => {
  const legs = [{ lowerBin: 1, upperBin: 30 }];
  const view = V({ activeBin: 10, flipLegs: legs });
  const ev = (pingpong, p = PP) => evaluateStrategyExit({ trade: T({ flipLegs: ["F"], pingpong }), view, p, now: M }).reason;
  assert.equal(ev({ phase: "drain", drainReason: "weak" }), "drain_weak");
  assert.equal(ev({ phase: "drain", drainReason: "trend_up" }), null);
  assert.equal(ev({ phase: "drain", drainReason: "trend_up", trendFailed: { time: 0, price: 0.9 } }), "trend_failed");
  assert.equal(ev({ phase: "drain", drainReason: "stuck" }), null);
  assert.equal(ev({ phase: "drain" }), null, "drained before this exit existed");
  // Off (atau trade lama tanpa key) = hanya trend_done.
  assert.equal(ev({ phase: "drain", drainReason: "weak" }, { ...PP, drainExit: false }), null);
  assert.equal(ev({ phase: "drain", drainReason: "weak" }, { ...PP, drainExit: undefined }), null);
  // trend_done tetap menang bila semua token sudah terjual.
  const sold = V({ activeBin: 31, flipLegs: legs });
  const t = T({ flipLegs: ["F"], pingpong: { phase: "drain", drainReason: "weak" } });
  assert.equal(evaluateStrategyExit({ trade: t, view: sold, p: PP, now: M }).reason, "trend_done");
  assert.match(strategyExitDetail("drain_weak", {}), /weak spike/);
  const failed = T({ pingpong: { phase: "drain", trendFailed: { time: 0, price: 0.00012341 } } });
  assert.match(strategyExitDetail("trend_failed", { trade: failed }), /below the Supertrend again at 0\.0001234 /);
});

test("ping-pong: range_broken uses the bottom of every leg", () => {
  const legs = [{ lowerBin: -80, upperBin: -60 }];
  const t = PPT("bid", { strategyState: { aboveSince: null, belowSince: 0 } });
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: -55, flipLegs: legs }), p: PP, now: 20 * M }).reason, null);
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: -81, flipLegs: legs }), p: PP, now: 20 * M }).reason, "range_broken");
});
