import test from "node:test";
import assert from "node:assert/strict";
import { computeSupertrend, detectTouch } from "../src/market/supertrend.js";

function candle(close) {
  return { time: 0, open: close, high: close + 1, low: close - 1, close, volume: 1 };
}

test("computeSupertrend returns null for insufficient data", () => {
  assert.equal(computeSupertrend([candle(1), candle(2)], 10, 3), null);
});

test("computeSupertrend returns a direction and a finite line", () => {
  const candles = Array.from({ length: 20 }, (_, i) => candle(100 + i));
  const result = computeSupertrend(candles, 10, 3);
  assert.ok(result);
  assert.ok(["bullish", "bearish"].includes(result.direction));
  assert.ok(Number.isFinite(result.line));
});

test("detectTouch flags a bearish wick touch", () => {
  const touch = detectTouch(candle(99), { direction: "bearish", line: 100 });
  assert.equal(touch.touches, true);
  assert.equal(touch.touchType, "high");
});

test("detectTouch flags a bullish wick touch", () => {
  const touch = detectTouch(candle(101), { direction: "bullish", line: 100 });
  assert.equal(touch.touches, true);
  assert.equal(touch.touchType, "low");
});

test("detectTouch returns false when price is away from the line", () => {
  const touch = detectTouch(
    { time: 0, open: 110, high: 111, low: 109, close: 110, volume: 1 },
    { direction: "bullish", line: 100 }
  );
  assert.equal(touch.touches, false);
  assert.equal(touch.touchType, null);
});

test("detectTouch handles missing inputs", () => {
  const touch = detectTouch(null, null);
  assert.equal(touch.touches, false);
});
