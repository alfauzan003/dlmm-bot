import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-mode-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { trackPosition, getTrackedPosition, updateTrackedMode } = await import("../src/state/positions.js");
const { classifyMode, isCompositeMode, isSpotDistribution, LEGACY_MODE } = await import("../src/exit/classify.js");

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

const flat = (n, v = "1000") => Array.from({ length: n }, () => ({ positionLiquidity: v }));
const ramp = (n) => Array.from({ length: n }, (_, i) => ({ positionLiquidity: String(1000 + i * 500) }));

test("isSpotDistribution: likuiditas rata = spot berapa pun jumlah bin", () => {
  assert.equal(isSpotDistribution(flat(10)), true);
  assert.equal(isSpotDistribution(flat(250)), true);
  // Bin aktif terisi sebagian tetap spot.
  assert.equal(isSpotDistribution([...flat(9), { positionLiquidity: "400" }]), true);
  // BidAsk/Curve menanjak dari bin aktif.
  assert.equal(isSpotDistribution(ramp(10)), false);
  assert.equal(isSpotDistribution(ramp(250)), false);
  // Terlalu sedikit bin berisi untuk dinilai.
  assert.equal(isSpotDistribution(flat(2)), false);
  assert.equal(isSpotDistribution([]), false);
  assert.equal(isSpotDistribution(undefined), false);
});

test("classifyMode: spot dari distribusi, bukan lebar range", () => {
  const base = { hasX: true, hasY: true, xIsSol: false, entryBaseAmount: 1, entrySolAmount: 1 };
  assert.equal(classifyMode({ ...base, binSpan: 9, spotDistribution: true }), "spot");
  assert.equal(classifyMode({ ...base, binSpan: 250, spotDistribution: false }), "bidask:double");
  assert.equal(classifyMode({ ...base, binSpan: 250 }), "bidask:double");
  const sol = classifyMode({ ...base, hasX: false, entryBaseAmount: 0, binSpan: 231, spotDistribution: false });
  assert.equal(sol, "bidask:sol");
  assert.equal(isCompositeMode(sol), true);
});

test("LEGACY_MODE maps legacy mode names", () => {
  assert.equal(LEGACY_MODE.bidask, "bidask:double");
  assert.equal(LEGACY_MODE["token-only"], "bidask:token");
  assert.equal(LEGACY_MODE["sol-only"], "bidask:sol");
});
