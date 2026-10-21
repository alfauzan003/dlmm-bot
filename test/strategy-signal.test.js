import test from "node:test";
import assert from "node:assert/strict";
import { buildProfile } from "../src/strategy/params.js";
import { entrySignal, binsForPct, pickRangePct, barsNeeded } from "../src/strategy/signal.js";

const bar = (o, h, l, c, t = 0) => ({ time: t, open: o, high: h, low: l, close: c, volume: 100 });
const p = { ...buildProfile({}, "degen"), pumpLookbackMin: 15 }; // W = 3 bars

test("signal fires on pump, pullback in band, red last bar", () => {
  const r = entrySignal([bar(1, 1.1, 1, 1.1), bar(1.1, 1.3, 1.1, 1.25), bar(1.25, 1.25, 1.1, 1.15)], p);
  assert.equal(r.enter, true);
  assert.equal(r.reason, "signal");
  assert.ok(Math.abs(r.metrics.pumpPct - 30) < 1e-9);
  assert.ok(Math.abs(r.metrics.pullbackPct - (1 - 1.15 / 1.3) * 100) < 1e-9);
});

test("signal reasons", () => {
  assert.equal(entrySignal([bar(1, 1, 1, 1)], p).reason, "not_enough_bars");
  assert.equal(entrySignal([bar(1, 1.1, 1, 1.1), bar(1.1, 1.15, 1.1, 1.12), bar(1.12, 1.12, 1.05, 1.06)], p).reason, "no_pump");
  assert.equal(entrySignal([bar(1, 1.3, 1, 1.3), bar(1.3, 1.3, 1.28, 1.3), bar(1.3, 1.3, 1.27, 1.28)], p).reason, "pullback_small");
  assert.equal(entrySignal([bar(1, 1.5, 1, 1.5), bar(1.5, 1.5, 1.0, 1.0), bar(1.0, 1.0, 0.9, 0.95)], p).reason, "pullback_large");
  assert.equal(entrySignal([bar(1, 1.3, 1, 1.3), bar(1.3, 1.3, 1.1, 1.15), bar(1.15, 1.2, 1.15, 1.18)], p).reason, "not_red");
});

test("immediate skips the signal but still needs one bar", () => {
  assert.equal(entrySignal([bar(1, 1, 1, 1)], { ...p, entryTiming: "immediate" }).enter, true);
  assert.equal(entrySignal([], { ...p, entryTiming: "immediate" }).enter, false);
});

test("pickRangePct fixed clamps to [min,max]", () => {
  const q = { ...p, rangeMode: "fixed", rangePct: 80, rangeMinPct: 20, rangeMaxPct: 65, maxPositions: 2 };
  assert.equal(pickRangePct([], q, 100), 65);
});

test("pickRangePct support = distance to lowest low + buffer", () => {
  const q = { ...p, rangeMode: "support", supportLookbackMin: 15, supportBufferPct: 5, rangeMinPct: 10, rangeMaxPct: 65, maxPositions: 2 };
  const bars = [bar(1, 1, 0.7, 0.9), bar(0.9, 1, 0.9, 1), bar(1, 1, 1, 1)];
  assert.ok(Math.abs(pickRangePct(bars, q, 100) - 35) < 1e-9); // (1 − 0.7/1)·100 + 5
  assert.equal(pickRangePct([bar(1, 1, 1, 1)], q, 100), 10); // support at price → min
});

test("pickRangePct shrinks to the bin cap and returns null when min does not fit", () => {
  const q = { ...p, rangeMode: "fixed", rangePct: 65, rangeMinPct: 20, rangeMaxPct: 65, maxPositions: 1 };
  const r = pickRangePct([], q, 80); // 65% needs 132 bins on bin step 80
  assert.ok(binsForPct(r, 80) + 1 <= 70);
  assert.equal(pickRangePct([], { ...q, rangeMinPct: 60 }, 20), null);
});

test("barsNeeded", () => {
  assert.equal(barsNeeded(buildProfile({}, "degen")), 13);
  assert.equal(barsNeeded(buildProfile({}, "multihour")), 289);
});
