import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan semua file runtime ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-toggles-"));
const STATE = path.join(TMP, "state.json");
const SETTINGS = path.join(TMP, "settings.json");
const POOLS = path.join(TMP, "pool.txt");
const STRAT = path.join(TMP, "strat.conf");
process.env.STATE_FILE = STATE;
process.env.SETTINGS_FILE = SETTINGS;
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SUPERTREND_CACHE_FILE = path.join(TMP, "supertrend-cache.json");

const POOL = "PoolToggle1111111111111111111111111111111111";
// Pool terpisah dari POOL: refreshCandidates menandai POOL sebagai "entered".
const WATCH_POOL = "PoolWatch11111111111111111111111111111111111";
const MINT = "MintToggle1111111111111111111111111111111111";

// Supertrend bullish untuk MINT (bar tutup terakhir), supaya watchPrices lanjut
// ke fetch harga Jupiter tanpa menyentuh GMGN.
const closedBar = Math.floor(Date.now() / 1000 / 900) * 900 - 900;
fs.writeFileSync(
  process.env.SUPERTREND_CACHE_FILE,
  JSON.stringify({
    schema: 2,
    savedAt: Date.now(),
    state: { [MINT]: { direction: "bullish", line: 1, closedBar, updatedAt: Date.now() } },
  })
);

// Spy fetch: hitung panggilan, kembalikan respons inert (tidak pernah ke jaringan).
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

// strat.conf sementara = salinan strat.conf asli + pool list sementara, supaya
// refreshCandidates punya satu pool tanpa menyentuh pool.txt produksi.
const realStrat = fs.readFileSync(new URL("../strat.conf", import.meta.url), "utf8");
fs.writeFileSync(STRAT, `${realStrat}\nPOOL_LIST_FILE=${POOLS}\nENTRY_ENABLED=true\nDCA_ENABLED=true\n`);
fs.writeFileSync(POOLS, `${POOL},0.1,3\n`);
process.env.STRAT_FILE = STRAT;

const { setToggle } = await import("../src/state/settings.js");
const { trackPosition } = await import("../src/state/positions.js");
const { refreshCandidates, watchAndEnter, _setCandidatesForTest } = await import("../src/entry/index.js");
const { tickDca } = await import("../src/entry/dca.js");

const POSITION = "PosToggle11111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(STATE, JSON.stringify({ positions: {} }));
}

test.beforeEach(() => {
  fs.rmSync(SETTINGS, { force: true });
  resetState();
  // Posisi bot yang sudah terbuka di pool => refreshCandidates tidak perlu RPC
  // saat toggle ON (pool dihitung sebagai "masih terbuka") dan mengembalikan [].
  trackPosition(POSITION, POOL, "TEST-SOL", "mint", 0, "bidask:double");
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("refreshCandidates returns null when autoEntry off", async () => {
  setToggle("autoEntry", false);
  assert.equal(await refreshCandidates(), null);
});

test("refreshCandidates runs when autoEntry on (toggle, not strat.conf, decides)", async () => {
  setToggle("autoEntry", true);
  assert.deepEqual(await refreshCandidates(), []);
});

test("watchAndEnter skips the Jupiter price fetch when autoEntry off, does it when on", async () => {
  _setCandidatesForTest([{ pool: WATCH_POOL, mint: MINT, sizeSol: 0.1, pairName: "TEST-SOL" }]);
  try {
    setToggle("autoEntry", false);
    let result;
    const offUrls = await withFetchSpy(async () => {
      result = await watchAndEnter();
    });
    assert.equal(result, null);
    assert.deepEqual(offUrls, [], "no fetch at all when autoEntry off");

    setToggle("autoEntry", true);
    const onUrls = await withFetchSpy(async () => {
      await watchAndEnter();
    });
    assert.ok(
      onUrls.some((u) => u.startsWith("https://api.jup.ag/price/")),
      "Jupiter price fetched when autoEntry on"
    );
  } finally {
    _setCandidatesForTest([]);
  }
});

test("tickDca does nothing when dca off", async () => {
  setToggle("dca", false);
  const before = fs.readFileSync(STATE);
  // Tanpa toggle, tickDca akan menarik PnL (fetch) untuk posisi eligible.
  const urls = await withFetchSpy(() => tickDca());
  assert.deepEqual(urls, [], "no PnL fetch when dca off");
  assert.ok(before.equals(fs.readFileSync(STATE)), "state file must be byte-identical");
});
