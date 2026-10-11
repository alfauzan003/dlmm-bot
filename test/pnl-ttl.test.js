import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// File state/settings diarahkan ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-pnl-ttl-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { pnlCacheTtlSec } = await import("../src/meteora/positions.js");
const { setToggle } = await import("../src/state/settings.js");
const { default: config } = await import("../src/config/index.js");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("PnL cache TTL follows the dca toggle in settings.json, not strat.conf", () => {
  setToggle("dca", false);
  assert.equal(pnlCacheTtlSec(), 0);
  setToggle("dca", true);
  assert.equal(pnlCacheTtlSec(), config.pollIntervalHold * 60);
});
