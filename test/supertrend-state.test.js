import test from "node:test";
import assert from "node:assert/strict";
import { supertrendFromClosed } from "../src/market/supertrend-state.js";

const BAR = 900;

function candle(time, close) {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 1 };
}

test("supertrendFromClosed returns null for insufficient candles", () => {
  assert.equal(supertrendFromClosed([candle(0, 1)], 10, 3), null);
});

test("supertrendFromClosed excludes the forming candle and returns a line", () => {
  const barStart = Math.floor(Date.now() / 1000 / BAR) * BAR;
  const candles = [];
  for (let i = 0; i < 20; i++) {
    candles.push(candle(barStart - (19 - i) * BAR, 100 + i));
  }
  const result = supertrendFromClosed(candles, 10, 3);
  assert.ok(result);
  assert.ok(["bullish", "bearish"].includes(result.direction));
  assert.ok(Number.isFinite(result.line));
});

test("supertrendFromClosed drops a forming candle and keeps computing", () => {
  const barStart = Math.floor(Date.now() / 1000 / BAR) * BAR;
  const candles = [];
  for (let i = 0; i < 21; i++) {
    candles.push(candle(barStart - (20 - i) * BAR, 100 + i));
  }
  // last candle = barStart (forming) — harus dibuang, sisanya dihitung
  const result = supertrendFromClosed(candles, 10, 3);
  assert.ok(result);
  assert.ok(Number.isFinite(result.line));
});

test("supertrendFromClosed rejects data missing the latest closed bar", () => {
  const barStart = Math.floor(Date.now() / 1000 / BAR) * BAR;
  const candles = [];
  for (let i = 0; i < 20; i++) {
    candles.push(candle(barStart - (21 - i) * BAR, 100 + i));
  }
  // last candle = barStart - 2*BAR (bar terakhir yang tutup belum ada)
  assert.equal(supertrendFromClosed(candles, 10, 3), null);
});
