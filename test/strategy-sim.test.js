import test from "node:test";
import assert from "node:assert/strict";
import { binsForPct } from "../src/strategy/screen.js";
import {
  bidAskWeights,
  barPath,
  createSimPosition,
  moveActive,
  accrueFees,
  pathVisits,
  positionValueSol,
} from "../src/strategy/sim.js";

test("bidAskWeights grow with distance and sum to 1", () => {
  const w = bidAskWeights(4);
  assert.deepEqual(
    w.map((x) => +x.toFixed(2)),
    [0.1, 0.2, 0.3, 0.4]
  );
});

test("barPath order", () => {
  assert.deepEqual(barPath({ open: 2, high: 3, low: 1, close: 1.5 }), [2, 3, 1, 1.5]);
  assert.deepEqual(barPath({ open: 2, high: 3, low: 1, close: 2.5 }), [2, 1, 3, 2.5]);
});

test("createSimPosition matches pctToBinRange bin count", () => {
  const pos = createSimPosition({ depositSol: 1, rangePct: 50, binStep: 100, p0: 1 });
  assert.equal(pos.n, binsForPct(50, 100) + 1);
  const total = [...pos.bins.values()].reduce((s, b) => s + b.sol, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.ok(pos.bins.get(-(pos.n - 1)).sol > pos.bins.get(0).sol);
});

test("moveActive down converts crossed bins to token at bin price; back up restores value", () => {
  const pos = createSimPosition({ depositSol: 1, rangePct: 10, binStep: 100, p0: 1 });
  const s0 = pos.bins.get(0).sol;
  const s1 = pos.bins.get(-1).sol;
  moveActive(pos, -2);
  assert.equal(pos.bins.get(0).sol, 0);
  assert.ok(Math.abs(pos.bins.get(0).token - s0) < 1e-12);
  assert.ok(Math.abs(pos.bins.get(-1).token - s1 / 1.01 ** -1) < 1e-12);
  assert.ok(pos.bins.get(-2).sol > 0); // new active bin not converted
  moveActive(pos, 1);
  assert.ok(Math.abs(positionValueSol(pos, 1.01) - 1) < 1e-9); // all SOL again, value preserved
});

test("accrueFees uses our share of each visited bin", () => {
  const pos = createSimPosition({ depositSol: 1, rangePct: 10, binStep: 100, p0: 1 });
  const our0 = pos.bins.get(0).sol;
  const got = accrueFees(pos, { visits: [0], volumeSol: 100, lpFeeRate: 0.01, poolLiqSolAt: () => our0 });
  assert.ok(Math.abs(got - 0.5) < 1e-12); // 100 * 1% * 50%
  assert.equal(pos.feesSol, got);
  assert.equal(accrueFees(pos, { visits: [5], volumeSol: 100, lpFeeRate: 0.01, poolLiqSolAt: () => 1 }), 0);
});

test("pathVisits", () => {
  assert.deepEqual(pathVisits(2, -1), [2, 1, 0, -1]);
  assert.deepEqual(pathVisits(0, 0), [0]);
});
