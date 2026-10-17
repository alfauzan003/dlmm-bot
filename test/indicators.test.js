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
