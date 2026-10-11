import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-mode-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { trackPosition, getTrackedPosition, updateTrackedMode } = await import("../src/state/positions.js");
const { classifyMode, isCompositeMode } = await import("../src/exit/classify.js");

const POOL = "PoolPaid111111111111111111111111111111111";
const POS = "PosPaid1111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

test("isCompositeMode menolak mode legacy numerik dan menerima mode composite", () => {
  assert.equal(isCompositeMode("bidask:double"), true);
  assert.equal(isCompositeMode("spot"), true);
  assert.equal(isCompositeMode("spot:sol"), false);
  assert.equal(isCompositeMode(0), false);
  assert.equal(isCompositeMode(1), false);
  assert.equal(isCompositeMode(undefined), false);
});

test("updateTrackedMode mereparasi mode numerik menjadi composite", () => {
  resetState();
  trackPosition(POS, POOL, "PAID-SOL", "mint", 1, 0);
  assert.equal(getTrackedPosition(POS).mode, 0);
  assert.equal(isCompositeMode(getTrackedPosition(POS).mode), false);

  updateTrackedMode(POS, "bidask:double");
  assert.equal(getTrackedPosition(POS).mode, "bidask:double");
  assert.equal(isCompositeMode(getTrackedPosition(POS).mode), true);
});

test("classifyMode mengembalikan mode composite dari data posisi", () => {
  const bidask = classifyMode({
    hasX: true,
    hasY: true,
    binSpan: 34,
    xIsSol: false,
    entryBaseAmount: 1,
    entrySolAmount: 1,
  });
  assert.equal(bidask, "bidask:double");
  assert.equal(isCompositeMode(bidask), true);

  const spot = classifyMode({
    hasX: true,
    hasY: true,
    binSpan: 200,
    xIsSol: false,
    entryBaseAmount: 1,
    entrySolAmount: 1,
  });
  assert.equal(spot, "spot");
  assert.equal(isCompositeMode(spot), true);
});

test("classifyMode: span >= 200 selalu spot, di bawahnya bidask", () => {
  const spotSol = classifyMode({
    hasX: false,
    hasY: true,
    binSpan: 231,
    xIsSol: false,
    entryBaseAmount: 0,
    entrySolAmount: 1,
  });
  assert.equal(spotSol, "spot");

  const bidaskEdge = classifyMode({
    hasX: true,
    hasY: true,
    binSpan: 199,
    xIsSol: false,
    entryBaseAmount: 1,
    entrySolAmount: 1,
  });
  assert.equal(bidaskEdge, "bidask:double");
});

test("entry/execute.js memanggil trackPosition dengan urutan argumen yang benar", () => {
  const src = fs.readFileSync(new URL("../src/entry/execute.js", import.meta.url), "utf8");
  const match = src.match(/trackPosition\(([\s\S]*?)\);/);
  assert.ok(match, "panggilan trackPosition tidak ditemukan di entry/execute.js");

  const args = match[1].split(",").map((a) => a.trim());
  assert.equal(args.length, 7, `trackPosition harus 7 argumen, dapat ${args.length}: ${match[1]}`);
  assert.equal(args[4], "collectFeeMode", "argumen ke-5 harus collectFeeMode");
  assert.equal(args[5], '"bidask:double"', 'argumen ke-6 (mode) harus "bidask:double"');
  assert.equal(args[6], "isDca", "argumen ke-7 harus isDca");
});
