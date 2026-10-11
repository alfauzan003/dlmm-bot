import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state/settings ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-sweep-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { runSafetySweep } = await import("../src/exit/sweep.js");
const { setToggle } = await import("../src/state/settings.js");
const { addKeepMint } = await import("../src/state/keep-mints.js");

function reset() {
  fs.rmSync(process.env.STATE_FILE, { force: true });
  fs.rmSync(process.env.SETTINGS_FILE, { force: true });
}

function fakeSweep() {
  const calls = [];
  const sweepToSol = async (opts) => {
    calls.push(opts);
    return { failedMints: [] };
  };
  return { calls, sweepToSol };
}

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("sweep is a no-op while autoEntry, deterministicExit and dca are all off", async () => {
  reset();
  const { calls, sweepToSol } = fakeSweep();
  await runSafetySweep({ deps: { sweepToSol } });
  assert.equal(calls.length, 0);
});

test("sweep runs when a legacy toggle is on and skips mints the user kept", async () => {
  for (const name of ["autoEntry", "deterministicExit", "dca"]) {
    reset();
    setToggle(name, true);
    addKeepMint("KeptMint");
    const { calls, sweepToSol } = fakeSweep();
    await runSafetySweep({ deps: { sweepToSol } });
    assert.equal(calls.length, 1, name);
    assert.ok(calls[0].excludeMints.includes("KeptMint"), name);
  }
});
