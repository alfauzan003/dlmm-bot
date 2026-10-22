import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan semua file runtime ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-toggles-"));
const STATE = path.join(TMP, "state.json");
const SETTINGS = path.join(TMP, "settings.json");
const STRAT = path.join(TMP, "strat.conf");
process.env.STATE_FILE = STATE;
process.env.SETTINGS_FILE = SETTINGS;
process.env.PAPER_FILE = path.join(TMP, "paper-trades.json");
process.env.STRATEGY_LOG_FILE = path.join(TMP, "strategy-log.jsonl");
process.env.BACKTEST_DIR = path.join(TMP, "backtest");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

// Spy fetch: catat URL, kembalikan respons gagal (tidak pernah ke jaringan) => profil dilewati.
async function withFetchSpy(fn) {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) };
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return urls;
}

// strat.conf sementara = salinan strat.conf asli + profil degen aktif.
const realStrat = fs.readFileSync(new URL("../strat.conf", import.meta.url), "utf8");
fs.writeFileSync(STRAT, `${realStrat}\nDEGEN_ON=true\n`);
process.env.STRAT_FILE = STRAT;

const { setToggle } = await import("../src/state/settings.js");
const { runScan } = await import("../src/strategy/runner.js");
const tg = await import("../src/notify/telegram.js");

test.beforeEach(() => {
  fs.rmSync(SETTINGS, { force: true });
  fs.writeFileSync(STATE, JSON.stringify({ positions: {} }));
  // runScan mengirim digest Telegram: jangan pernah ke bot sungguhan.
  tg.__setSender(async () => null);
});

test.after(() => {
  tg.__setSender(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("runScan returns without fetching when autoEntry off; fetches the datapi pool list when on", async () => {
  setToggle("autoEntry", false);
  const offUrls = await withFetchSpy(() => runScan());
  assert.deepEqual(offUrls, [], "no fetch at all when autoEntry off");

  setToggle("autoEntry", true);
  const onUrls = await withFetchSpy(() => runScan());
  assert.ok(
    onUrls.some((u) => u.startsWith("https://dlmm.datapi.meteora.ag/pools?")),
    "datapi pool list fetched when autoEntry on"
  );
});
