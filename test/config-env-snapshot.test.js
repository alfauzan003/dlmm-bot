import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// .env / strat.conf / settings sementara SEBELUM config di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-envsnap-"));
const ENV = path.join(TMP, ".env");
const SETTINGS = path.join(TMP, "settings.json");
fs.writeFileSync(ENV, "DRY_RUN=true\n");
fs.writeFileSync(path.join(TMP, "strat.conf"), "SOL_MODE=false\n");
process.env.ENV_FILE = ENV;
process.env.STRAT_FILE = path.join(TMP, "strat.conf");
process.env.SETTINGS_FILE = SETTINGS;

const { default: config, reloadConfig } = await import("../src/config/index.js");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("a strat reload never applies a pending .env edit (DRY_RUN stays as booted)", () => {
  assert.equal(config.dryRun, true);
  fs.writeFileSync(ENV, "DRY_RUN=false\n");
  fs.writeFileSync(SETTINGS, JSON.stringify({ stratOverrides: { SOL_MODE: "true" } }));
  reloadConfig();
  assert.equal(config.solMode, true);
  assert.equal(config.dryRun, true);
});
