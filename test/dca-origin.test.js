import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Arahkan semua file runtime ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-dca-origin-"));
const STATE = path.join(TMP, "state.json");
const POOLS = path.join(TMP, "pool.txt");
const STRAT = path.join(TMP, "strat.conf");
process.env.STATE_FILE = STATE;
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SUPERTREND_CACHE_FILE = path.join(TMP, "supertrend-cache.json");
// Wallet sekali pakai: fetchPoolPnl memanggil getWallet(), jangan bergantung pada .env.
process.env.WALLET_KEY_FILE = path.join(TMP, "wallet.key");
fs.writeFileSync(process.env.WALLET_KEY_FILE, bs58.encode(Keypair.generate().secretKey));

const POOL = "PoolDcaOrigin1111111111111111111111111111111";
const realStrat = fs.readFileSync(new URL("../strat.conf", import.meta.url), "utf8");
fs.writeFileSync(STRAT, `${realStrat}\nPOOL_LIST_FILE=${POOLS}\nDRY_RUN=true\n`);
fs.writeFileSync(POOLS, `${POOL},0.1,3\n`);
process.env.STRAT_FILE = STRAT;

const { setToggle } = await import("../src/state/settings.js");
const { trackPosition, getTrackedPosition } = await import("../src/state/positions.js");
const { createTrade } = await import("../src/state/trades.js");
const { tickDca, processDca, maybeStartDca, isDcaPositionEligible } = await import("../src/entry/dca.js");

const exit = { tp: { enabled: false }, sl: { enabled: false }, trail: { enabled: false } };

// Posisi bidask:double terlacak; origin null = tanpa trade sama sekali.
function setup(addr, origin) {
  trackPosition(addr, POOL, "TEST-SOL", "mint", 0, "bidask:double");
  if (origin) createTrade({ pool: POOL, pair: "TEST-SOL", baseMint: "mint", positions: [addr], origin, exit });
}

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

test.beforeEach(() => {
  fs.rmSync(process.env.SETTINGS_FILE, { force: true });
  fs.writeFileSync(STATE, JSON.stringify({ positions: {} }));
  setToggle("dca", true);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const NOT_AUTO = [
  ["manual", "PosManual"],
  ["external", "PosExternal"],
  [null, "PosNoTrade"],
];

for (const [origin, addr] of NOT_AUTO) {
  test(`non-auto position (${origin ?? "no trade"}) is not DCA-eligible: tickDca/processDca/maybeStartDca skip it`, async () => {
    setup(addr, origin);
    assert.equal(isDcaPositionEligible(getTrackedPosition(addr)), false);

    const before = fs.readFileSync(STATE);
    const urls = await withFetchSpy(() => tickDca());
    assert.deepEqual(urls, [], "no PnL fetch for a non-auto position");
    assert.ok(before.equals(fs.readFileSync(STATE)), "state unchanged");

    processDca({ position: addr, pool: POOL, pnlPct: -15 }, getTrackedPosition(addr), "TEST");
    assert.equal(getTrackedPosition(addr).dcaArmed, false, "not armed");

    const started = maybeStartDca({ position: addr, pool: POOL, pnlPct: -5 }, getTrackedPosition(addr), "TEST");
    assert.equal(started, false);
    assert.notEqual(getTrackedPosition(addr).dcaTriggered, true, "no DCA reservation");
  });
}

test("auto position stays DCA-eligible: fetched, armed and DCA started", async () => {
  setup("PosAuto", "auto");
  assert.equal(isDcaPositionEligible(getTrackedPosition("PosAuto")), true);

  const urls = await withFetchSpy(() => tickDca());
  assert.ok(urls.length > 0, "PnL fetched for an auto position");

  processDca({ position: "PosAuto", pool: POOL, pnlPct: -15 }, getTrackedPosition("PosAuto"), "TEST");
  assert.equal(getTrackedPosition("PosAuto").dcaArmed, true, "armed");

  const started = maybeStartDca({ position: "PosAuto", pool: POOL, pnlPct: -5 }, getTrackedPosition("PosAuto"), "TEST");
  assert.equal(started, true, "dry-run DCA started");
  assert.equal(getTrackedPosition("PosAuto").dcaTriggered, true);
});
