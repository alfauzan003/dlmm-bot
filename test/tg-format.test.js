import test from "node:test";
import assert from "node:assert/strict";
import { fmtUsd, fmtPct, fmtSol, shortAddr, fmtWib, exitSummary, esc } from "../src/tg/format.js";

test("fmtUsd", () => {
  assert.equal(fmtUsd(3.1), "$3.10");
  assert.equal(fmtUsd(-3.1), "-$3.10");
  assert.equal(fmtUsd(null), "?");
});

test("fmtPct", () => {
  assert.equal(fmtPct(4.2), "+4.20%");
  assert.equal(fmtPct(-1), "-1.00%");
  assert.equal(fmtPct(null), "?");
});

test("fmtSol", () => {
  assert.equal(fmtSol(0.5), "0.5 SOL");
  assert.equal(fmtSol(1), "1 SOL");
  assert.equal(fmtSol(0.123456), "0.1235 SOL");
});

test("shortAddr", () => {
  assert.equal(shortAddr("So11111111111111111111111111111111111111112"), "So11…1112");
});

test("fmtWib", () => {
  assert.equal(fmtWib(Date.UTC(2026, 9, 11, 2, 1)), "2026-10-11 09:01 WIB");
});

test("exitSummary", () => {
  const all = {
    tp: { on: true, pct: 15 },
    sl: { on: true, pct: 25 },
    trail: { on: true, startPct: 5, distancePct: 3 },
  };
  assert.equal(exitSummary(all), "TP15 SL-25 T5/3");
  assert.equal(exitSummary({ ...all, sl: { on: false, pct: 25 }, trail: { on: false } }), "TP15");
  assert.equal(exitSummary({ tp: { on: false }, sl: { on: false }, trail: { on: false } }), "no exits");
  assert.equal(exitSummary(null), "no exits");
  assert.equal(exitSummary({ ...all, panda: { on: true } }), "TP15 SL-25 T5/3 Panda");
  assert.equal(
    exitSummary({ tp: { on: false }, sl: { on: false }, trail: { on: false }, panda: { on: true } }),
    "Panda"
  );
});

test("esc", () => {
  assert.equal(esc("a<b>&c"), "a&lt;b&gt;&amp;c");
});
