import test from "node:test";
import assert from "node:assert/strict";
import { resolveTrailingReference } from "../src/exit/trailing.js";
import { canArmIndicatorTrailing, trailingDropThreshold } from "../src/state/trailing.js";

const RULES = { trailingTakeProfit: true, trailingTriggerPct: 10 };

test("indicator armed memakai anchor, bukan lastPnlPeak", () => {
  const tracked = { trailingArmedBy: "rsi_bb", trailingAnchor: 3, lastPnlPeak: 7 };
  const out = resolveTrailingReference(tracked, 3, RULES);
  assert.deepEqual(out, { reference: 3, isIndicator: true });
});

test("anchor mengikuti puncak pasca-sinyal", () => {
  const tracked = { trailingArmedBy: "rsi_bb", trailingAnchor: 3, lastPnlPeak: 7 };
  const out = resolveTrailingReference(tracked, 8, RULES);
  assert.deepEqual(out, { reference: 8, isIndicator: true });
});

test("anchor null diinisialisasi dari PnL saat ini", () => {
  const tracked = { trailingArmedBy: "rsi_bb", trailingAnchor: null, lastPnlPeak: 9 };
  const out = resolveTrailingReference(tracked, 4, RULES);
  assert.deepEqual(out, { reference: 4, isIndicator: true });
});

test("peak murni memakai lastPnlPeak saat >= trigger", () => {
  const tracked = { trailingArmedBy: null, trailingAnchor: null, lastPnlPeak: 12 };
  const out = resolveTrailingReference(tracked, 8, RULES);
  assert.deepEqual(out, { reference: 12, isIndicator: false });
});

test("peak murni di bawah trigger tidak aktif", () => {
  const tracked = { trailingArmedBy: null, lastPnlPeak: 7 };
  assert.equal(resolveTrailingReference(tracked, 7, RULES), null);
});

test("peak murni nonaktif bila trailingTakeProfit false", () => {
  const tracked = { trailingArmedBy: null, lastPnlPeak: 12 };
  assert.equal(resolveTrailingReference(tracked, 8, { ...RULES, trailingTakeProfit: false }), null);
});

test("referensi null bila PnL belum tersedia", () => {
  assert.equal(resolveTrailingReference({ trailingArmedBy: "rsi_bb", trailingAnchor: 3 }, null, RULES), null);
});

test("canArmIndicatorTrailing: peak murni menang", () => {
  assert.equal(canArmIndicatorTrailing({ trailingActive: true, trailingArmedBy: null }), false);
});

test("canArmIndicatorTrailing: sinyal berulang tidak reset", () => {
  assert.equal(canArmIndicatorTrailing({ trailingActive: true, trailingArmedBy: "rsi_bb" }), false);
});

test("canArmIndicatorTrailing: posisi tertutup tidak di-arm", () => {
  assert.equal(canArmIndicatorTrailing({ closed: true, trailingActive: false, trailingArmedBy: null }), false);
});

test("canArmIndicatorTrailing: posisi baru boleh di-arm", () => {
  assert.equal(canArmIndicatorTrailing({ closed: false, trailingActive: false, trailingArmedBy: null }), true);
});

test("trailingDropThreshold: rasio dipakai saat peak tinggi", () => {
  assert.equal(trailingDropThreshold(50, 8, 1.5), 4);
  assert.equal(trailingDropThreshold(100, 8, 1.5), 8);
});

test("trailingDropThreshold: floor menahan saat peak rendah", () => {
  assert.equal(trailingDropThreshold(10, 8, 1.5), 1.5);
  assert.equal(trailingDropThreshold(5, 8, 1.5), 1.5);
});

test("trailingDropThreshold: titik temu rasio dan floor di peak 18.75", () => {
  assert.equal(trailingDropThreshold(18.75, 8, 1.5), 1.5);
});

test("trailingDropThreshold: reference <= 0 atau null pakai floor", () => {
  assert.equal(trailingDropThreshold(0, 8, 1.5), 1.5);
  assert.equal(trailingDropThreshold(-3, 8, 1.5), 1.5);
  assert.equal(trailingDropThreshold(null, 8, 1.5), 1.5);
});
