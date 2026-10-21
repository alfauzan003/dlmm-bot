import test from "node:test";
import assert from "node:assert/strict";
import { buildProfile } from "../src/strategy/params.js";
import { STRATEGY_EXIT_REASONS, tokenPos, evaluateStrategyExit } from "../src/strategy/exits.js";

const P = { ...buildProfile({}, "degen"), oorAboveMin: 10, oorBelowMin: 15, lowVolumeBars: 3, minVolume5mUsd: 1000, maxHoldMin: 120 };
const T = (o = {}) => ({ range: { lowerBin: -50, upperBin: 0 }, openedAt: 0, ...o });
const V = (o = {}) => ({ activeBin: -10, xIsSol: false, flipLegs: [], volumes: [5000, 5000, 5000], ...o });
const M = 60_000;

test("reasons list and tokenPos", () => {
  assert.deepEqual(STRATEGY_EXIT_REASONS, ["cycle_done", "pumped_away", "range_broken", "volume_died", "max_hold"]);
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
