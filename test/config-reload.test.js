import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// strat.conf & settings.json sementara SEBELUM config di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-reload-"));
const STRAT = path.join(TMP, "strat.conf");
const SETTINGS = path.join(TMP, "settings.json");
fs.copyFileSync(new URL("../strat.conf", import.meta.url), STRAT);
process.env.STRAT_FILE = STRAT;
process.env.SETTINGS_FILE = SETTINGS;

const { default: config, buildConfig, reloadConfig } = await import("../src/config/index.js");
const { loadEnv } = await import("../src/config/env.js");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("reloadConfig applies overrides in place and keeps nested identity", () => {
  const baselineMode = buildConfig(loadEnv()).entry.fees.mode;
  const fees = config.entry.fees;
  const spot = config.spot;
  fs.writeFileSync(
    SETTINGS,
    JSON.stringify({
      stratOverrides: { ENTRY_FEE_MODE: "both", SPOT_TRAILING_TRIGGER_PCT: "33", ENTRY_SIZE_SPLIT: "0.3" },
    })
  );
  reloadConfig();
  assert.equal(config.entry.fees, fees);
  assert.equal(config.spot, spot);
  assert.equal(config.entry.fees.mode, "both");
  assert.equal(config.rulesFor("spot").trailingTriggerPct, 33);
  assert.equal(config.entry.sizeSplit, 0.3);
  fs.writeFileSync(SETTINGS, "{}");
  reloadConfig();
  assert.equal(config.entry.fees.mode, baselineMode);
});

test("reloadConfig restores dryRun from .env even after a test mutated it", () => {
  const before = config.dryRun;
  config.dryRun = !before;
  reloadConfig();
  assert.equal(config.dryRun, before);
});
