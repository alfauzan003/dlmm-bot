import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-flip-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { selectFlipBins, flipRange, canFlip } = await import("../src/lp/flip-trade.js");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const bins = (from, to, tokenAmount = 1) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ binId: from + i, tokenAmount }));

test("selectFlipBins: baseIsX takes bins above active, skips active and empty", () => {
  const r = selectFlipBins({
    activeBinId: 100,
    baseIsX: true,
    legs: [
      {
        position: "P1",
        bins: [
          { binId: 98, tokenAmount: 0 },
          { binId: 100, tokenAmount: 5 },
          { binId: 101, tokenAmount: 3 },
          { binId: 102, tokenAmount: 0 },
          { binId: 103, tokenAmount: 2 },
        ],
      },
    ],
  });
  assert.deepEqual(r, { binCount: 2, legs: [{ position: "P1", fromBinId: 101, toBinId: 103 }] });
});

test("selectFlipBins: token Y takes bins below active", () => {
  const r = selectFlipBins({
    activeBinId: 100,
    baseIsX: false,
    legs: [{ position: "P1", bins: [...bins(97, 99), { binId: 100, tokenAmount: 4 }, { binId: 101, tokenAmount: 4 }] }],
  });
  assert.deepEqual(r, { binCount: 3, legs: [{ position: "P1", fromBinId: 97, toBinId: 99 }] });
});

test("selectFlipBins: caps at maxBins nearest active across legs", () => {
  const r = selectFlipBins({
    activeBinId: 100,
    baseIsX: true,
    maxBins: 70,
    legs: [
      { position: "P1", bins: bins(101, 140) },
      { position: "P2", bins: bins(141, 200) },
    ],
  });
  assert.deepEqual(r, {
    binCount: 70,
    legs: [
      { position: "P1", fromBinId: 101, toBinId: 140 },
      { position: "P2", fromBinId: 141, toBinId: 170 },
    ],
  });
});

test("selectFlipBins: default cap is 70", () => {
  const r = selectFlipBins({ activeBinId: 0, baseIsX: true, legs: [{ position: "P1", bins: bins(1, 100) }] });
  assert.equal(r.binCount, 70);
  assert.deepEqual(r.legs, [{ position: "P1", fromBinId: 1, toBinId: 70 }]);
});

test("selectFlipBins: nothing on token side → binCount 0, legs []", () => {
  const r = selectFlipBins({ activeBinId: 100, baseIsX: true, legs: [{ position: "P1", bins: bins(80, 100) }] });
  assert.deepEqual(r, { binCount: 0, legs: [] });
});

test("flipRange mirrors on the token side", () => {
  assert.deepEqual(flipRange(100, 5, true), { minBinId: 101, maxBinId: 105 });
  assert.deepEqual(flipRange(100, 5, false), { minBinId: 95, maxBinId: 99 });
});

test("canFlip only for bid_ask and mixed", () => {
  assert.equal(canFlip({ shape: "bid_ask" }), true);
  assert.equal(canFlip({ shape: "mixed" }), true);
  assert.equal(canFlip({ shape: "spot" }), false);
  assert.equal(canFlip({ shape: "curve" }), false);
  assert.equal(canFlip({ shape: null }), false);
  assert.equal(canFlip(undefined), false);
});
