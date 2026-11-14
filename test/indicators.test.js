import test from "node:test";
import assert from "node:assert/strict";
import { rsi, macd, bollinger } from "../src/market/indicators.js";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("rsi uses Wilder smoothing", () => {
  assert.deepEqual(rsi([1, 2, 3, 2, 3], 2), [null, null, 100, 50, 75]);
});

test("rsi with only losses is 0 and short input is all null", () => {
  assert.equal(rsi([3, 2, 1], 2)[2], 0);
  assert.deepEqual(rsi([1, 2], 2), [null, null]);
});

test("bollinger is SMA ± k * population stdev", () => {
  const b = bollinger([1, 2, 3, 4], 2, 2);
  assert.equal(b.upper[0], null);
  assert.deepEqual([b.middle[1], b.upper[1], b.lower[1]], [1.5, 2.5, 0.5]);
  assert.equal(b.upper[3], 4.5);
});

test("macd on a linear series", () => {
  const closes = Array.from({ length: 40 }, (_, i) => i + 1);
  const m = macd(closes, 3, 6, 3);
  assert.equal(m.macd[4], null);
  near(m.macd[5], 1.5);
  assert.equal(m.hist[6], null);
  near(m.hist[7], 0);
  near(m.signal[39], 1.5);
});

test("macd flat series is zero", () => {
  const m = macd(Array(40).fill(5), 12, 26, 9);
  assert.equal(m.hist.at(-1), 0);
});

import { atr, adx } from "../src/market/indicators.js";

test("atr is Wilder-smoothed true range", () => {
  const c = [
    { high: 2, low: 1, close: 1.5 },
    { high: 3, low: 2, close: 2.5 },
    { high: 2.6, low: 2.4, close: 2.5 },
  ];
  // TR = 1, max(1, 1.5, 0.5) = 1.5, max(0.2, 0.1, 0.1) = 0.2
  const a = atr(c, 2);
  assert.equal(a[0], null);
  assert.equal(a[1], 1.25);
  assert.ok(Math.abs(a[2] - (1.25 + 0.2) / 2) < 1e-12);
  assert.deepEqual(atr(c, 5), [null, null, null]);
});

test("adx: steady uptrend → 100, flat → 0, warm-up null", () => {
  const up = Array.from({ length: 40 }, (_, i) => ({ high: 10 + i + 1, low: 10 + i, close: 10 + i + 0.5 }));
  const a = adx(up, 14);
  assert.equal(a[12], null);
  assert.ok(a[26] != null);
  assert.ok(Math.abs(a.at(-1) - 100) < 1e-9);
  const flat = Array.from({ length: 40 }, () => ({ high: 2, low: 1, close: 1.5 }));
  assert.equal(adx(flat, 14).at(-1), 0);
});
