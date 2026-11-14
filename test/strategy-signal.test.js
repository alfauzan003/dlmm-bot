import test from "node:test";
import assert from "node:assert/strict";
import { buildProfile } from "../src/strategy/params.js";
import { athAtl, fibPrice, fibSignal, explainRangePct, maxPctForBins, binsForPct } from "../src/strategy/signal.js";

const P = buildProfile({}, "bidask_flip"); // fib 0.382 / 0.786, min 30, cap 10, 2 positions
const bar = (high, low) => ({ time: 0, open: low, high, low, close: low, volume: 1 });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("athAtl takes the highest high and lowest low across series", () => {
  assert.deepEqual(athAtl([bar(2, 1), bar(5, 0.5)], [bar(3, 0.8)]), { ath: 5, atl: 0.5 });
  assert.equal(athAtl([], []), null);
  assert.equal(athAtl([bar(1, 1)]), null); // ath == atl
  assert.deepEqual(athAtl([bar(NaN, -1), bar(2, 1)]), { ath: 2, atl: 1 });
});

test("fibPrice: 0 = ATH, 1 = ATL", () => {
  assert.equal(fibPrice(10, 2, 0), 10);
  assert.equal(fibPrice(10, 2, 1), 2);
  assert.ok(near(fibPrice(10, 2, 0.382), 10 - 0.382 * 8));
});

test("fibSignal skips a price above fib 0.382 and enters at or below it", () => {
  // ATL 1, ATH 11: fib 0.382 = 7.18, fib 0.786 = 3.14
  const above = fibSignal({ ath: 11, atl: 1, price: 8 }, P);
  assert.equal(above.enter, false);
  assert.equal(above.reason, "above_fib");
  const at = fibSignal({ ath: 11, atl: 1, price: 7.18 }, P);
  assert.equal(at.enter, true);
  const r = fibSignal({ ath: 11, atl: 1, price: 5 }, P);
  assert.equal(r.reason, "signal");
  assert.ok(near(r.metrics.fibEntry, 7.18));
  assert.ok(near(r.metrics.fibDeep, 3.14));
  assert.ok(near(r.metrics.maxPct, ((7.18 - 3.14) / 7.18) * 100)); // ≈ 56.27%
});

test("fibSignal without history", () => {
  assert.equal(fibSignal({ price: 1 }, P).reason, "no_history");
  assert.equal(fibSignal({ ath: 1, atl: 2, price: 1 }, P).reason, "no_history");
  assert.equal(fibSignal({ ath: 2, atl: 1, price: 0 }, P).reason, "no_history");
});

test("explainRangePct: target = min + (min(v, cap) / cap) · (max − min)", () => {
  const p = { ...P, maxPositions: 10 }; // tanpa batas bin
  assert.ok(near(explainRangePct({ maxPct: 56, volatility: 0 }, p, 100).pct, 30));
  assert.ok(near(explainRangePct({ maxPct: 56, volatility: 5 }, p, 100).pct, 43));
  assert.ok(near(explainRangePct({ maxPct: 56, volatility: 10 }, p, 100).pct, 56));
  assert.ok(near(explainRangePct({ maxPct: 56, volatility: 25 }, p, 100).pct, 56)); // v dipotong di cap
  // max di bawah min: range = min
  assert.ok(near(explainRangePct({ maxPct: 20, volatility: 5 }, p, 100).pct, 30));
  assert.match(explainRangePct({ maxPct: 56, volatility: 5 }, p, 100).why, /vol 5\.00\/10 · min 30\.0% · max 56\.0% → 43\.0%/);
});

test("explainRangePct caps at maxPositions × 70 bins and skips invalid input", () => {
  const cap = maxPctForBins(2 * 70, 80); // ≈ 67%
  const r = explainRangePct({ maxPct: 90, volatility: 10 }, P, 80);
  assert.ok(near(r.pct, cap));
  assert.match(r.why, /capped by 2 position\(s\)/);
  assert.equal(binsForPct(r.pct - 1e-9, 80) + 1 <= 140, true);
  assert.equal(explainRangePct({ maxPct: 56, volatility: null }, P, 80).pct, null);
  assert.equal(explainRangePct({ maxPct: NaN, volatility: 3 }, P, 80).pct, null);
});

test("explainRangePct: max below min uses min (never under RANGE_MIN_PCT)", () => {
  const p = { rangeMinPct: 30, volatilityCap: 10, maxPositions: 2 };
  // Leonida-SOL: max 25.4%, vol 2.29 dulu memberi 29.0%.
  const r = explainRangePct({ maxPct: 25.4124, volatility: 2.2885 }, p, 80);
  assert.equal(r.pct, 30);
  assert.equal(r.why, "max 25.4% < min 30.0% → min 30.0%");
  assert.equal(explainRangePct({ maxPct: 10, volatility: 10 }, p, 80).pct, 30);
});
