import test from "node:test";
import assert from "node:assert/strict";
import { computeRSI, computeMACD, computeBB } from "../src/market/indicators.js";

test("computeRSI returns 100 when there are only gains", () => {
  const rsi = computeRSI([1, 2, 3, 4, 5], 2);
  assert.equal(rsi.length, 3);
  assert.equal(rsi[rsi.length - 1], 100);
});

test("computeRSI returns 0 when there are only losses", () => {
  const rsi = computeRSI([5, 4, 3, 2, 1], 2);
  assert.equal(rsi[rsi.length - 1], 0);
});

test("computeRSI returns empty for insufficient data", () => {
  assert.deepEqual(computeRSI([1, 2], 2), []);
});

test("computeBB collapses to a single value for a flat series", () => {
  const bb = computeBB([10, 10, 10, 10, 10], 5, 2);
  assert.equal(bb.middle, 10);
  assert.equal(bb.upper, 10);
  assert.equal(bb.lower, 10);
});

test("computeBB returns nulls for insufficient data", () => {
  const bb = computeBB([1, 2, 3], 20, 2);
  assert.deepEqual(bb, { upper: null, middle: null, lower: null });
});

test("computeMACD signals insufficient data", () => {
  const macd = computeMACD([1, 2, 3], 12, 26, 9);
  assert.deepEqual(macd.macd, []);
  assert.equal(macd.macdGreen, false);
});

test("computeMACD returns a boolean macdGreen with enough data", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const macd = computeMACD(closes, 12, 26, 9);
  assert.equal(typeof macd.macdGreen, "boolean");
  assert.ok(Array.isArray(macd.histogram));
});

test("computeMACD macdGreen true saat histogram terakhir positif", () => {
  const up = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.1);
  assert.equal(computeMACD(up, 12, 26, 9).macdGreen, true);
});

test("computeMACD macdGreen false saat histogram terakhir negatif", () => {
  const down = Array.from({ length: 60 }, (_, i) => 1000 - i * i * 0.1);
  assert.equal(computeMACD(down, 12, 26, 9).macdGreen, false);
});
