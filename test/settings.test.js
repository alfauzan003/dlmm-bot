import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file settings ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-settings-"));
const FILE = path.join(TMP, "settings.json");
process.env.SETTINGS_FILE = FILE;

const { DEFAULT_SETTINGS, getSettings, isOn, setToggle, setExitDefaults, exitPresetForNewTrade } =
  await import("../src/state/settings.js");

test.beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("first read creates defaults", () => {
  assert.equal(fs.existsSync(FILE), false);
  assert.deepEqual(getSettings(), DEFAULT_SETTINGS);
  assert.equal(fs.existsSync(FILE), true);
});

test("toggle persists", () => {
  setToggle("dca", true);
  assert.equal(JSON.parse(fs.readFileSync(FILE, "utf8")).dca, true);
  assert.equal(isOn("dca"), true);
});

test("unknown toggle throws", () => {
  assert.throws(() => setToggle("nope", true));
});

test("exit defaults merge", () => {
  const s = setExitDefaults({ tpPct: 20 });
  assert.equal(s.exitDefaults.tpPct, 20);
  assert.equal(s.exitDefaults.slPct, 25);
  assert.equal(getSettings().exitDefaults.slPct, 25);
});

test("preset follows autoExit", () => {
  assert.deepEqual(exitPresetForNewTrade().trail, { on: true, startPct: 5, distancePct: 3 });
  setToggle("autoExit", false);
  const p = exitPresetForNewTrade();
  assert.equal(p.tp.on, false);
  assert.equal(p.sl.on, false);
  assert.equal(p.trail.on, false);
});

test("corrupt file falls back to defaults", () => {
  fs.writeFileSync(FILE, "{oops");
  assert.equal(getSettings().autoExit, true);
});

test("missing keys are filled from defaults", () => {
  fs.writeFileSync(FILE, JSON.stringify({ dca: true, exitDefaults: { tpPct: 30 } }));
  const s = getSettings();
  assert.equal(s.dca, true);
  assert.equal(s.autoExit, true);
  assert.equal(s.exitDefaults.tpPct, 30);
  assert.equal(s.exitDefaults.slPct, 25);
});
