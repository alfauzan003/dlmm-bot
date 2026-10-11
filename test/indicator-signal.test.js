import test from "node:test";
import assert from "node:assert/strict";
import { detectIndicatorSignal, closedCandles } from "../src/exit/rules.js";

const BASE = {
  rsiLatest: 95,
  macdGreen: false,
  bbUpper: 100,
  highLatest: 101,
};

test("rsi_bb trigger saat high candle menembus BB upper", () => {
  assert.equal(detectIndicatorSignal(BASE), "rsi_bb");
});

test("rsi_bb trigger saat high tepat di BB upper", () => {
  assert.equal(detectIndicatorSignal({ ...BASE, highLatest: 100 }), "rsi_bb");
});

test("rsi_macd menang duluan saat bar MACD hijau", () => {
  assert.equal(detectIndicatorSignal({ ...BASE, macdGreen: true }), "rsi_macd");
});

test("rsi_macd menang walau bar sebelumnya bukan merah gelap", () => {
  assert.equal(detectIndicatorSignal({ ...BASE, macdGreen: true, highLatest: 99 }), "rsi_macd");
});

test("trigger saat RSI tepat 90", () => {
  assert.equal(detectIndicatorSignal({ ...BASE, rsiLatest: 90 }), "rsi_bb");
});

test("tidak trigger saat RSI < 90", () => {
  assert.equal(detectIndicatorSignal({ ...BASE, rsiLatest: 89.9 }), null);
});

test("tidak trigger saat high di bawah BB upper", () => {
  assert.equal(detectIndicatorSignal({ ...BASE, highLatest: 99 }), null);
});

test("tidak trigger saat bbUpper null", () => {
  assert.equal(detectIndicatorSignal({ ...BASE, bbUpper: null }), null);
});

test("closedCandles membuang candle terakhir (forming)", () => {
  const candles = [{ close: 1 }, { close: 2 }, { close: 3 }];
  assert.deepEqual(closedCandles(candles), [{ close: 1 }, { close: 2 }]);
});

test("closedCandles aman untuk data kosong/kurang", () => {
  assert.deepEqual(closedCandles([]), []);
  assert.deepEqual(closedCandles(null), []);
  assert.deepEqual(closedCandles([{ close: 1 }]), []);
});
