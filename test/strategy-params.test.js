import test from "node:test";
import assert from "node:assert/strict";
import { buildProfile, buildAutoEntry, profileExit, profileToConf } from "../src/strategy/params.js";

test("buildProfile uses defaults when env is empty", () => {
  const d = buildProfile({}, "degen");
  assert.equal(d.sizeSol, 0.5);
  assert.equal(d.maxPoolAgeH, 72);
  assert.equal(d.entryTiming, "pullback");
  assert.equal(d.rangeMode, "fixed");
  assert.equal(d.maxHoldMin, 120);
  const m = buildProfile({}, "multihour");
  assert.equal(m.minMcapUsd, 3000000);
  assert.equal(m.rangeMode, "support");
  assert.equal(m.maxHoldMin, 1440);
});

test("buildProfile reads prefixed keys and parses types", () => {
  const p = buildProfile(
    { MULTI_ON: "false", MULTI_MAX_OPEN: "3", MULTI_RANGE_MODE: "fixed", MULTI_FLIP_PCT: "70" },
    "multihour"
  );
  assert.deepEqual([p.on, p.maxOpen, p.rangeMode, p.flipPct], [false, 3, "fixed", 70]);
});

test("buildProfile orders inverted min/max pairs", () => {
  const p = buildProfile({ DEGEN_VOLATILITY_MIN_PCT: "5", DEGEN_VOLATILITY_MAX_PCT: "2" }, "degen");
  assert.deepEqual([p.volatilityMinPct, p.volatilityMaxPct], [2, 5]);
});

test("invalid enum falls back to default", () => {
  assert.equal(buildProfile({ DEGEN_ENTRY_TIMING: "maybe" }, "degen").entryTiming, "pullback");
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

test("profileToConf round-trips through buildProfile", () => {
  const p = buildProfile({ DEGEN_FLIP_PCT: "45" }, "degen");
  const env = Object.fromEntries(
    profileToConf(p)
      .trim()
      .split("\n")
      .map((l) => l.split("="))
  );
  assert.deepEqual(buildProfile(env, "degen"), p);
});

test("buildAutoEntry globals and sim defaults", () => {
  const g = buildAutoEntry({});
  assert.deepEqual(
    [g.scanIntervalSec, g.candidatesPerScan, g.cooldownMin, g.cooldownLossMin, g.dailyLossLimitSol],
    [60, 5, 120, 720, 0.5]
  );
  assert.deepEqual(g.sim, { poolDepthFactor: 1, poolSpreadBins: 69, swapCostPct: 1, txCostSol: 0.0002 });
});
