import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import
// agar test tidak menyentuh state.json / decision-log.json produksi.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-missing-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const {
  trackPosition,
  getTrackedPosition,
  getOpenTrackedPositions,
  registerMissedCycle,
  resetMissedCycle,
  markClosedNotDetected,
} = await import("../src/state/positions.js");

const POOL = "PoolFries111111111111111111111111111111111";
const POS = "PosFries1111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

test("trackPosition menginisialisasi missedCycles=0", () => {
  resetState();
  trackPosition(POS, POOL, "FRIES-SOL", "mint", 1, "bidask:double");
  assert.equal(getTrackedPosition(POS).missedCycles, 0);
  assert.equal(getOpenTrackedPositions().length, 1);
});

test("registerMissedCycle increment beruntun, reset memutus rentetan", () => {
  resetState();
  trackPosition(POS, POOL, "FRIES-SOL", "mint", 1, "bidask:double");
  assert.equal(registerMissedCycle(POS), 1);
  assert.equal(registerMissedCycle(POS), 2);
  assert.equal(registerMissedCycle(POS), 3);
  resetMissedCycle(POS);
  assert.equal(getTrackedPosition(POS).missedCycles, 0);
  assert.equal(registerMissedCycle(POS), 1);
});

test("markClosedNotDetected menutup posisi dan mencatat decision log", () => {
  resetState();
  trackPosition(POS, POOL, "FRIES-SOL", "mint", 1, "bidask:double");
  markClosedNotDetected(POS);
  const p = getTrackedPosition(POS);
  assert.equal(p.closed, true);
  assert.equal(p.closeReason, "not_detected");
  assert.equal(getOpenTrackedPositions().length, 0);
  const log = JSON.parse(fs.readFileSync(process.env.DECISION_LOG_FILE, "utf8"));
  assert.equal(log.length, 1);
  assert.equal(log[0].closeReason, "not_detected");
});

test("getOpenTrackedPositions mengecualikan entri yang sudah closed", () => {
  resetState();
  trackPosition("posA", POOL, "A-SOL", "mA", 1, "bidask:double");
  trackPosition("posB", POOL, "B-SOL", "mB", 1, "bidask:double");
  markClosedNotDetected("posA");
  const open = getOpenTrackedPositions();
  assert.deepEqual(
    open.map((x) => x.position),
    ["posB"]
  );
});
