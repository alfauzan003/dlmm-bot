import test from "node:test";
import assert from "node:assert/strict";
import { PROFILES, buildProfile, buildAutoEntry, profileExit, profileAutoFlip } from "../src/strategy/params.js";

test("only the bidask flip strategy exists", () => {
  assert.deepEqual(PROFILES, ["bidask_flip"]);
});

test("buildProfile uses the spec defaults when env is empty", () => {
  const p = buildProfile({}, "bidask_flip");
  assert.deepEqual(
    [p.minMcapUsd, p.maxMcapUsd, p.minTokenAgeH, p.maxTokenAgeH, p.minHolders, p.maxTop10Pct],
    [200000, 5000000, 2, 0, 500, 30]
  );
  assert.deepEqual([p.minFees30mUsd, p.minBaseFeePct, p.minFeeActiveTvl30mPct, p.minBinStep], [1, 1, 0.2, 80]);
  assert.deepEqual([p.fibEntryLevel, p.fibDeepLevel, p.rangeMinPct, p.volatilityCap], [0.382, 0.786, 30, 10]);
  assert.deepEqual([p.flipPct, p.flipStep], [65, 10]);
});

test("buildProfile reads BIDASK_ keys and parses types", () => {
  const p = buildProfile({ BIDASK_ON: "false", BIDASK_MAX_OPEN: "3.7", BIDASK_FLIP_PCT: "70" }, "bidask_flip");
  assert.deepEqual([p.on, p.maxOpen, p.flipPct], [false, 3, 70]);
});

test("buildProfile orders inverted pairs; 0 max means no max", () => {
  const p = buildProfile(
    { BIDASK_MIN_MCAP_USD: "900", BIDASK_MAX_MCAP_USD: "100", BIDASK_FIB_ENTRY_LEVEL: "0.786", BIDASK_FIB_DEEP_LEVEL: "0.382" },
    "bidask_flip"
  );
  assert.deepEqual([p.minMcapUsd, p.maxMcapUsd, p.fibEntryLevel, p.fibDeepLevel], [100, 900, 0.382, 0.786]);
  const q = buildProfile({ BIDASK_MIN_TOKEN_AGE_H: "5", BIDASK_MAX_TOKEN_AGE_H: "0" }, "bidask_flip");
  assert.deepEqual([q.minTokenAgeH, q.maxTokenAgeH], [5, 0]);
});

test("profileExit: 0 means off", () => {
  const e = profileExit({ tpPct: 10, slPct: 0, trailStartPct: 5, trailDistancePct: 0 });
  assert.deepEqual(e, {
    tp: { on: true, pct: 10 },
    sl: { on: false, pct: 0 },
    trail: { on: false, startPct: 5, distancePct: 0 },
    panda: { on: false },
  });
});

test("profileAutoFlip: pct + step, step 0 = once, pct 0 = off", () => {
  assert.deepEqual(profileAutoFlip({ flipPct: 65, flipStep: 10 }), { pct: 65, step: 10 });
  assert.deepEqual(profileAutoFlip({ flipPct: 65, flipStep: 0 }), { pct: 65 });
  assert.equal(profileAutoFlip({ flipPct: 0, flipStep: 10 }), null);
});

test("buildAutoEntry globals and sim defaults", () => {
  const g = buildAutoEntry({});
  assert.deepEqual(
    [g.scanIntervalSec, g.candidatesPerScan, g.cooldownMin, g.cooldownLossMin, g.dailyLossLimitSol, g.dexpaprikaHistoryDays],
    [300, 3, 120, 720, 0.5, 7]
  );
  assert.deepEqual(g.sim, { poolDepthFactor: 1, poolSpreadBins: 69, swapCostPct: 1, txCostSol: 0.0002 });
  assert.deepEqual(Object.keys(g.profiles), ["bidask_flip"]);
});

test("ping-pong defaults, enum parsing and max hold", () => {
  const p = buildProfile({}, "bidask_flip");
  assert.equal(p.flipMode, "pingpong");
  assert.deepEqual(
    [p.ppStAtrPeriod, p.ppStMultiplier, p.ppSpikeAtrMult, p.ppSpikeLookbackBars, p.ppDipMinPct],
    [10, 3, 2, 4, 5]
  );
  assert.deepEqual([p.ppMinBbWidthPct, p.ppMaxAdx, p.ppMinVolRatio, p.maxHoldMin], [15, 35, 0.5, 1440]);
  assert.equal(p.drainExit, true);
  assert.equal(buildProfile({ BIDASK_DRAIN_EXIT: "false" }, "bidask_flip").drainExit, false);
  assert.equal(buildProfile({ BIDASK_FLIP_MODE: " PCT " }, "bidask_flip").flipMode, "pct");
  assert.equal(buildProfile({ BIDASK_FLIP_MODE: "zigzag" }, "bidask_flip").flipMode, "pingpong");
});

test("profileAutoFlip: ping-pong keeps only the first flip (no step)", () => {
  assert.deepEqual(profileAutoFlip({ flipMode: "pingpong", flipPct: 65, flipStep: 10 }), { pct: 65 });
  assert.equal(profileAutoFlip({ flipMode: "pingpong", flipPct: 0, flipStep: 10 }), null);
  assert.deepEqual(profileAutoFlip({ flipMode: "pct", flipPct: 65, flipStep: 10 }), { pct: 65, step: 10 });
});
