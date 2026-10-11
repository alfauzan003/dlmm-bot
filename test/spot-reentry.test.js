import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-reentry-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { trackPosition, getTrackedPosition, recordTrackedRange, getSpotReentryCount, setSpotReentryCount } =
  await import("../src/state/positions.js");
const { reentryBinRange, shouldReenter, canSpotReenter, nonRefundableCost, exceedsNonRefundable } =
  await import("../src/exit/spot-reentry.js");

const POOL = "PoolReentry11111111111111111111111111111111";
const POS = "PosReentry111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

test("reentryBinRange: anchor ke active, span ke bawah", () => {
  assert.deepEqual(reentryBinRange(1000, 244), { minBinId: 756, maxBinId: 1000 });
  assert.deepEqual(reentryBinRange(1000, 0), { minBinId: 1000, maxBinId: 1000 });
  assert.deepEqual(reentryBinRange(1000, -5), { minBinId: 1000, maxBinId: 1000 });
});

test("shouldReenter: butuh enabled, size>0, mode spot, reason oor_kanan, span valid, di bawah max", () => {
  const cfg = { enabled: true, sizeSol: 1, maxReentries: 10 };
  assert.equal(shouldReenter({ mode: "spot", reason: "oor_kanan", span: 244, count: 0, cfg }), true);
  assert.equal(shouldReenter({ mode: "spot", reason: "oor_kanan", span: 244, count: 9, cfg }), true);
  assert.equal(shouldReenter({ mode: "spot", reason: "oor_kanan", span: 244, count: 10, cfg }), false);
  assert.equal(shouldReenter({ mode: "spot", reason: "oor_kiri", span: 244, count: 0, cfg }), false);
  assert.equal(shouldReenter({ mode: "spot", reason: "oor_kanan", span: 0, count: 0, cfg }), false);
  assert.equal(shouldReenter({ mode: "bidask:double", reason: "oor_kanan", span: 244, count: 0, cfg }), false);
  assert.equal(
    shouldReenter({ mode: "spot", reason: "oor_kanan", span: 244, count: 0, cfg: { ...cfg, enabled: false } }),
    false
  );
  assert.equal(
    shouldReenter({ mode: "spot", reason: "oor_kanan", span: 244, count: 0, cfg: { ...cfg, sizeSol: 0 } }),
    false
  );
});

test("nonRefundableCost: jumlahkan binArray + bitmap, abaikan sewa refundable", () => {
  assert.equal(nonRefundableCost({ binArrayCost: 0.07143744, bitmapExtensionCost: 0 }), 0.07143744);
  assert.ok(Math.abs(nonRefundableCost({ binArrayCost: 0.07143744, bitmapExtensionCost: 0.05 }) - 0.12143744) < 1e-12);
  assert.equal(nonRefundableCost({ binArrayCost: 0, bitmapExtensionCost: 0, positionCost: 0.0574 }), 0);
  assert.equal(nonRefundableCost({}), 0);
  assert.equal(nonRefundableCost(null), 0);
});

test("exceedsNonRefundable: 0 = tolak bila ada, batas custom, nilai invalid = 0", () => {
  assert.equal(exceedsNonRefundable(0, 0), false);
  assert.equal(exceedsNonRefundable(0.07143744, 0), true);
  assert.equal(exceedsNonRefundable(0.07143744, 0.1), false);
  assert.equal(exceedsNonRefundable(0.12143744, 0.1), true);
  assert.equal(exceedsNonRefundable(0.07143744, undefined), true);
});

test("counter re-entry tersimpan per posisi", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  assert.equal(getSpotReentryCount(POS), 0);
  setSpotReentryCount(POS, 3);
  assert.equal(getSpotReentryCount(POS), 3);
  assert.equal(getTrackedPosition(POS).spotReentryCount, 3);
});

test("canSpotReenter membaca binSpan + counter dari state", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const pos = { position: POS, mode: "spot" };

  // Belum ada binSpan tercatat -> tidak layak.
  assert.equal(canSpotReenter(pos, "oor_kanan"), false);

  recordTrackedRange(POS, 100, 344); // span 244
  assert.equal(canSpotReenter(pos, "oor_kanan"), true);
  assert.equal(canSpotReenter(pos, "oor_kiri"), false);

  setSpotReentryCount(POS, 10);
  assert.equal(canSpotReenter(pos, "oor_kanan"), false);
});
