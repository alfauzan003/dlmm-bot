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
  flipSimPosition,
  simulateTrade,
} from "../src/strategy/sim.js";
import { buildAutoEntry, buildProfile } from "../src/strategy/params.js";

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

const sim = buildAutoEntry({}).sim;
const pool = { binStep: 100, baseFeePct: 2, protocolFeePct: 10, tvlUsd: 100000 };
const flat = (t, px, v = 0) => ({ time: t, open: px, high: px, low: px, close: px, volume: v });
const base = {
  ...buildProfile({}, "degen"),
  rangeMode: "fixed",
  rangePct: 30,
  rangeMinPct: 10,
  flipPct: 60,
  tpPct: 0,
  slPct: 0,
  trailStartPct: 0,
  oorAboveMin: 10,
  oorBelowMin: 15,
  lowVolumeBars: 0,
  maxHoldMin: 0,
  sizeSol: 1,
};

test("flipSimPosition mirrors withdrawn bins above price", () => {
  const pos = createSimPosition({ depositSol: 1, rangePct: 10, binStep: 100, p0: 1 });
  moveActive(pos, -5);
  const r = flipSimPosition(pos);
  assert.equal(r.binCount, 5);
  assert.deepEqual(pos.flip, { lo: -4, hi: 0 });
  assert.ok(pos.bins.get(0).token > pos.bins.get(-4).token); // heavier further from price
});

test("flat price, no volume: loses only tx costs and ends at end_of_data", () => {
  const bars = [flat(0, 1), flat(300, 1), flat(600, 1)];
  const r = simulateTrade({ bars, entryIndex: 1, p: base, pool, solUsdAt: () => 100, sim });
  assert.equal(r.exitReason, "end_of_data");
  assert.equal(r.flipped, false);
  assert.ok(Math.abs(r.pnlSol - -(2 * sim.txCostSol)) < 1e-9);
});

test("dump through 60% flips, bounce above flip leg ends with cycle_done", () => {
  const bars = [flat(0, 1), flat(300, 1), flat(600, 0.75), flat(900, 1.1)];
  const r = simulateTrade({ bars, entryIndex: 1, p: base, pool, solUsdAt: () => 100, sim });
  assert.equal(r.flipped, true);
  assert.equal(r.exitReason, "cycle_done");
});

test("dump below range for oorBelowMin ends with range_broken and a loss", () => {
  const bars = [flat(0, 1), flat(300, 1), ...Array.from({ length: 5 }, (_, i) => flat(600 + 300 * i, 0.5))];
  const r = simulateTrade({ bars, entryIndex: 1, p: base, pool, solUsdAt: () => 100, sim });
  assert.equal(r.exitReason, "range_broken");
  assert.ok(r.pnlPct < -20);
});

test("volume in range earns fees", () => {
  const bars = [flat(0, 1), { time: 300, open: 1, high: 1, low: 0.97, close: 0.99, volume: 1e6 }, flat(600, 1)];
  const r = simulateTrade({ bars, entryIndex: 1, p: base, pool, solUsdAt: () => 100, sim });
  assert.ok(r.feesSol > 0);
});

test("TP from profile exit fires", () => {
  // Chop berat volume di dalam range, harga kembali ke entry: fee mendorong PnL melewati tpPct.
  const chop = { time: 300, open: 1, high: 1, low: 0.97, close: 1, volume: 1e6 };
  const bars = [flat(0, 1), chop, flat(600, 1), flat(900, 1)];
  const r = simulateTrade({ bars, entryIndex: 1, p: { ...base, tpPct: 0.5 }, pool, solUsdAt: () => 100, sim });
  assert.equal(r.exitReason, "tp");
  assert.equal(r.exitIndex, 2);
  assert.ok(r.feesSol > 0.005);
});

test("stopAtSec closes with reason stop", () => {
  const bars = [flat(0, 1), flat(300, 1), flat(600, 1), flat(900, 1)];
  assert.equal(
    simulateTrade({ bars, entryIndex: 1, p: base, pool, solUsdAt: () => 100, sim, stopAtSec: 600 }).exitReason,
    "stop"
  );
});

test("explicit rangePct overrides pickRangePct", () => {
  // −25%: bin −29. A 60% range (92 bins below) is 31% crossed → no flip; a 20% range (22 bins below) is past 60% → flip.
  const bars = [flat(0, 1), flat(300, 1), flat(600, 0.75)];
  const q = { ...base, rangePct: 60 };
  assert.equal(simulateTrade({ bars, entryIndex: 1, p: q, pool, solUsdAt: () => 100, sim }).flipped, false);
  assert.equal(
    simulateTrade({ bars, entryIndex: 1, p: q, pool, solUsdAt: () => 100, sim, rangePct: 20 }).flipped,
    true
  );
});

test("no range when rangeMin cannot fit → null", () => {
  assert.equal(
    simulateTrade({
      bars: [flat(0, 1), flat(300, 1)],
      entryIndex: 1,
      p: { ...base, rangeMinPct: 60, rangePct: 60, maxPositions: 1 },
      pool: { ...pool, binStep: 20 },
      solUsdAt: () => 100,
      sim,
    }),
    null
  );
});
