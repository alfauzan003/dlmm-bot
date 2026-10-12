import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state/settings ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-fallback-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { usesOorKiriFallback } = await import("../src/exit/spot-fallback.js");
const { buildConfig } = await import("../src/config/index.js");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const CFG = { enabled: true, modes: ["spot", "bidask:double", "bidask:sol"] };

test("OOR kiri of a listed mode goes to the token-only fallback", () => {
  for (const mode of CFG.modes) assert.equal(usesOorKiriFallback(mode, "oor_kiri", CFG), true, mode);
});

test("bidask:token never falls back, even when listed", () => {
  const cfg = { ...CFG, modes: [...CFG.modes, "bidask:token"] };
  assert.equal(usesOorKiriFallback("bidask:token", "oor_kiri", cfg), false);
});

test("only oor_kiri, only listed modes, only while enabled", () => {
  assert.equal(usesOorKiriFallback("spot", "stop_loss", CFG), false);
  assert.equal(usesOorKiriFallback("spot", "oor_kanan", CFG), false);
  assert.equal(usesOorKiriFallback("bidask:double", "oor_kiri", { enabled: true, modes: ["spot"] }), false);
  assert.equal(usesOorKiriFallback("spot", "oor_kiri", { ...CFG, enabled: false }), false);
});

test("SPOT_FALLBACK_MODES defaults to spot only and parses a comma list", () => {
  assert.deepEqual(buildConfig({}).spotFallback.modes, ["spot"]);
  assert.deepEqual(buildConfig({ SPOT_FALLBACK_MODES: " spot , bidask:sol ," }).spotFallback.modes, [
    "spot",
    "bidask:sol",
  ]);
});
