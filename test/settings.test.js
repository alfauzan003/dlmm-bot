import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file settings ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-settings-"));
const FILE = path.join(TMP, "settings.json");
process.env.SETTINGS_FILE = FILE;
const STRAT = path.join(TMP, "strat.conf");
fs.writeFileSync(STRAT, "EVIL_PANDA_RSI_LEVEL=90\nSOL_MODE=false\n");
process.env.STRAT_FILE = STRAT;

const {
  DEFAULT_SETTINGS,
  getSettings,
  isOn,
  setToggle,
  setExitDefaults,
  exitPresetForNewTrade,
  getRangePresets,
  setRangePreset,
  resetRangePresets,
  getDepositPresets,
  setDepositPresets,
  resetDepositPresets,
  setAutoFlipDefault,
  getStratOverrides,
  setStratOverride,
  clearStratOverride,
  clearStratOverrides,
} = await import("../src/state/settings.js");
const { default: config } = await import("../src/config/index.js");

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
  setToggle("autoEntry", true);
  assert.equal(JSON.parse(fs.readFileSync(FILE, "utf8")).autoEntry, true);
  assert.equal(isOn("autoEntry"), true);
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

test("exitPresetForNewTrade: Evil Panda follows its default only while Auto Exit is ON", () => {
  const before = config.evilPanda.defaultOn;
  try {
    assert.deepEqual(exitPresetForNewTrade().panda, { on: false });
    config.evilPanda.defaultOn = true;
    assert.deepEqual(exitPresetForNewTrade().panda, { on: true });
    setToggle("autoExit", false);
    assert.deepEqual(exitPresetForNewTrade().panda, { on: false });
  } finally {
    config.evilPanda.defaultOn = before;
  }
});

test("corrupt file falls back to defaults", () => {
  fs.writeFileSync(FILE, "{oops");
  assert.equal(getSettings().autoExit, true);
});

test("missing keys are filled from defaults", () => {
  fs.writeFileSync(FILE, JSON.stringify({ autoEntry: true, exitDefaults: { tpPct: 30 } }));
  const s = getSettings();
  assert.equal(s.autoEntry, true);
  assert.equal(s.autoExit, true);
  assert.equal(s.exitDefaults.tpPct, 30);
  assert.equal(s.exitDefaults.slPct, 25);
});

test("range presets default to the built-in values with labels", () => {
  const presets = getRangePresets();
  assert.equal(presets.length, 6);
  assert.deepEqual(presets[0], { key: "narrow", label: "Narrow", below: 20, above: 20 });
  assert.deepEqual(presets[5], { key: "wide_sol", label: "Wide SOL", below: 65, above: 0 });
});

test("setRangePreset persists and getRangePresets reflects it", () => {
  setRangePreset("narrow", { below: 15, above: 25 });
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, "utf8")).rangePresets.narrow, { below: 15, above: 25 });
  assert.deepEqual(getRangePresets()[0], { key: "narrow", label: "Narrow", below: 15, above: 25 });
});

test("setRangePreset validates values and keeps SOL presets SOL-only", () => {
  assert.throws(() => setRangePreset("narrow", { below: 0, above: 20 }));
  assert.throws(() => setRangePreset("narrow", { below: 100, above: 20 }));
  assert.throws(() => setRangePreset("narrow", { below: 20, above: 1001 }));
  assert.throws(() => setRangePreset("narrow_sol", { below: 20, above: 5 }));
  assert.throws(() => setRangePreset("nope", { below: 20, above: 20 }));
  setRangePreset("narrow_sol", { below: 30, above: 0 });
  assert.equal(getRangePresets()[3].below, 30);
});

test("resetRangePresets restores defaults", () => {
  setRangePreset("wide", { below: 80, above: 90 });
  resetRangePresets();
  assert.deepEqual(getRangePresets()[2], { key: "wide", label: "Wide", below: 65, above: 65 });
});

test("deposit presets default, persist, validate and reset", () => {
  assert.deepEqual(getDepositPresets(), [0.5, 0.7, 0.9, 1]);
  setDepositPresets([0.3, 0.5, 1, 2]);
  assert.deepEqual(getDepositPresets(), [0.3, 0.5, 1, 2]);
  assert.throws(() => setDepositPresets([0.3, 0.5, 1]));
  assert.throws(() => setDepositPresets([0.3, 0, 1, 2]));
  assert.throws(() => setDepositPresets([0.3, -1, 1, 2]));
  resetDepositPresets();
  assert.deepEqual(getDepositPresets(), [0.5, 0.7, 0.9, 1]);
});

test("invalid stored presets fall back to defaults", () => {
  fs.writeFileSync(
    FILE,
    JSON.stringify({
      rangePresets: { narrow: { below: 500, above: 1 }, narrow_sol: { below: 10, above: 9 } },
      depositPresets: [1, 2],
    })
  );
  assert.deepEqual(getRangePresets()[0], { key: "narrow", label: "Narrow", below: 20, above: 20 });
  assert.deepEqual(getRangePresets()[3], { key: "narrow_sol", label: "Narrow SOL", below: 20, above: 0 });
  assert.deepEqual(getDepositPresets(), [0.5, 0.7, 0.9, 1]);
});

test("auto flip default is off and can be set or cleared", () => {
  assert.equal(getSettings().autoFlipPct, null);
  assert.equal(setAutoFlipDefault(30).autoFlipPct, 30);
  assert.equal(getSettings().autoFlipPct, 30);
  assert.equal(setAutoFlipDefault(null).autoFlipPct, null);
  assert.equal(getSettings().autoFlipPct, null);
});

test("auto flip default rejects values outside 1..100", () => {
  for (const bad of [0, 101, Number.NaN, -5]) assert.throws(() => setAutoFlipDefault(bad));
});

test("invalid auto flip default in the file falls back to off", () => {
  fs.writeFileSync(FILE, JSON.stringify({ autoFlipPct: 250 }));
  assert.equal(getSettings().autoFlipPct, null);
});

test("setStratOverride validates, stores, and reloads config", () => {
  assert.deepEqual(setStratOverride("EVIL_PANDA_RSI_LEVEL", "150"), {
    ok: false,
    error: "EVIL_PANDA_RSI_LEVEL must be a number between 0 and 100",
  });
  assert.deepEqual(getStratOverrides(), {});
  assert.deepEqual(setStratOverride("EVIL_PANDA_RSI_LEVEL", "95"), { ok: true, value: "95", previous: null });
  assert.equal(config.evilPanda.rsi.level, 95);
  assert.equal(JSON.parse(fs.readFileSync(FILE, "utf8")).stratOverrides.EVIL_PANDA_RSI_LEVEL, "95");
  assert.deepEqual(setStratOverride("EVIL_PANDA_RSI_LEVEL", "80"), { ok: true, value: "80", previous: "95" });
  clearStratOverride("EVIL_PANDA_RSI_LEVEL");
  assert.equal(config.evilPanda.rsi.level, 90);
  assert.deepEqual(getStratOverrides(), {});
});

test("setStratOverride rejects keys that are not in strat.conf", () => {
  assert.equal(setStratOverride("DRY_RUN", "false").ok, false);
  assert.deepEqual(getStratOverrides(), {});
});

test("other settings writes keep stratOverrides", () => {
  setStratOverride("SOL_MODE", "true");
  setToggle("autoEntry", true);
  setExitDefaults({ tpPct: 20 });
  setDepositPresets([1, 2, 3, 4]);
  assert.deepEqual(getStratOverrides(), { SOL_MODE: "true" });
  clearStratOverrides();
  assert.deepEqual(getStratOverrides(), {});
  assert.equal(config.solMode, false);
});

test("withDefaults drops malformed stratOverrides", () => {
  fs.writeFileSync(FILE, JSON.stringify({ stratOverrides: { A: "1", B: 2, C: null } }));
  assert.deepEqual(getSettings().stratOverrides, { A: "1" });
  fs.writeFileSync(FILE, JSON.stringify({ stratOverrides: ["x"] }));
  assert.deepEqual(getSettings().stratOverrides, {});
});
