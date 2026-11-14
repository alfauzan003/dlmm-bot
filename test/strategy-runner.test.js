import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Semua file runtime ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-runner-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");
process.env.PAPER_FILE = path.join(TMP, "paper-trades.json");
process.env.STRATEGY_LOG_FILE = path.join(TMP, "strategy-log.jsonl");
const STRAT = path.join(TMP, "strat.conf");
fs.writeFileSync(STRAT, fs.readFileSync(new URL("../strat.conf", import.meta.url), "utf8"));
process.env.STRAT_FILE = STRAT;

const { default: config } = await import("../src/config/index.js");
const { buildAutoEntry } = await import("../src/strategy/params.js");
const { fibSignal, explainRangePct } = await import("../src/strategy/signal.js");
const { setToggle, isOn } = await import("../src/state/settings.js");
const { periodStart } = await import("../src/lp/pnl-stats.js");
const tg = await import("../src/notify/telegram.js");
const { runScan, getScreenSnapshot, _resetRunnerForTest } = await import("../src/strategy/runner.js");
const runtime = await import("../src/entry/runtime.js");

const NOW = 1_800_000_000_000;
const POOL = "PoolRunner111111111111111111111111111111111";
const MINT = "MintRunner111111111111111111111111111111111";

// Nilai default terkunci (tidak bergantung strat.conf lokal).
function resetConfig() {
  Object.assign(config.autoEntry, buildAutoEntry({}));
  config.entry.maxFailures = 3;
  config.entry.failureCooldownSec = 300;
  config.entry.gasReserve = 0.05;
}

// Riwayat 1h (DexPaprika, USD): ATL 0.5, ATH 2 -> fib 0.382 = 1.427, fib 0.786 = 0.821.
const HISTORY = [
  { time: 0, open: 0.5, high: 1, low: 0.5, close: 1, volume: 1 },
  { time: 3600, open: 1, high: 2, low: 1, close: 1.2, volume: 1 },
];
// Volatility Meteora 24h per pool.
const VOL = 5;
// 5m terakhir (GMGN, USD); close terakhir = harga sekarang. Default 1 = di bawah fib 0.382 -> entry.
const recent = (price = 1) => ({ bars: [{ time: 7200, open: price, high: price, low: price, close: price, volume: 1 }], source: "gmgn" });
const ABOVE_FIB = 1.6;

const ROW = {
  address: POOL,
  name: "AAA-SOL",
  baseMint: MINT,
  baseIsX: true,
  binStep: 100,
  baseFeePct: 2,
  protocolFeePct: 5,
  tvlUsd: 50000,
  volume30mUsd: 50000,
  feeTvl30mPct: 1.5,
  mcapUsd: 1_000_000,
  holders: 2000,
  createdAt: NOW - 3_600_000,
  tokenCreatedAt: NOW - 10 * 3_600_000,
  top10Pct: 10,
  fees30mUsd: 100,
  feeActiveTvl30mPct: 1.8,
  activeTvlUsd: 40000,
  basePriceUsd: 1,
};

const TOKEN = {
  id: MINT,
  mcap: 1_000_000,
  holderCount: 2000,
  createdAt: new Date(NOW - 10 * 3_600_000).toISOString(),
  audit: { topHoldersPercentage: 10, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
};

// Semua deps di-stub; mencatat panggilan. `over` menimpa stub tertentu.
function makeDeps(over = {}) {
  const calls = { fetchPoolRows: [], fetchTokens: [], planOpen: [], executeOpen: [], notify: [], failed: [], aborted: [] };
  let now = NOW;
  const deps = {
    now: () => now,
    dryRun: false,
    fetchPoolRows: async (url) => {
      calls.fetchPoolRows.push(url);
      return [ROW];
    },
    fetchTokens: async (mints) => {
      calls.fetchTokens.push(mints);
      return new Map([[MINT, TOKEN]]);
    },
    fetchVolatility: async (addresses) => new Map(addresses.map((a) => [a, VOL])),
    fetchRecent5mUsd: async () => recent(),
    fetchHistory1hUsd: async () => HISTORY,
    listOpenTrades: () => [],
    listClosedTrades: () => [],
    getSolBalance: async () => 10,
    planOpen: async (args) => {
      calls.planOpen.push(args);
      return { poolAddress: POOL, pair: "AAA-SOL", baseMint: MINT, positionCount: 1, nonRefundableSol: 0 };
    },
    executeOpen: async (plan, opts) => {
      calls.executeOpen.push({ plan, opts });
      return { success: true, trade: { id: 1 } };
    },
    notify: (a) => calls.notify.push(a),
    notifyEntryFailed: (a) => calls.failed.push(a),
    notifyEntryAborted: (a) => calls.aborted.push(a),
    ...over,
  };
  return { deps, calls, setNow: (ms) => (now = ms) };
}

test.beforeEach(() => {
  fs.rmSync(process.env.SETTINGS_FILE, { force: true });
  setToggle("autoEntry", true);
  resetConfig();
  _resetRunnerForTest();
  tg.__setSender(async () => null);
});

test.after(() => {
  tg.__setSender(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const flipP = () => config.autoEntry.profiles.bidask_flip;
// Range yang diharapkan untuk fixture: maxPct dari fib, volatility ROW (5).
const expectedRange = () => {
  const sig = fibSignal({ ath: 2, atl: 0.5, price: 1 }, flipP());
  return explainRangePct({ maxPct: sig.metrics.maxPct, volatility: VOL }, flipP(), ROW.binStep).pct;
};

test("fixture: price 1 is below fib 0.382, 1.6 is above", () => {
  assert.equal(fibSignal({ ath: 2, atl: 0.5, price: 1 }, flipP()).enter, true);
  assert.equal(fibSignal({ ath: 2, atl: 0.5, price: ABOVE_FIB }, flipP()).reason, "above_fib");
  // maxPct = (1.427 − 0.821) / 1.427 ≈ 42.5%; vol 5 / cap 10 -> 30 + 0.5 · 12.5 ≈ 36.2%
  assert.ok(Math.abs(expectedRange() - 36.24) < 0.01);
});

test("runScan does nothing when Auto Entry is off", async () => {
  setToggle("autoEntry", false);
  const { deps, calls } = makeDeps();
  await runScan({ deps });
  assert.equal(calls.fetchPoolRows.length, 0);
});

test("happy path opens one live trade with auto meta", async () => {
  const p = flipP();
  const { deps, calls } = makeDeps();
  await runScan({ deps });

  assert.equal(calls.fetchPoolRows.length, 1, "one strategy scanned");
  assert.ok(calls.fetchPoolRows[0].startsWith("https://pool-discovery-api.datapi.meteora.ag/pools?"));
  assert.equal(calls.planOpen.length, 1);
  const args = calls.planOpen[0];
  assert.equal(args.poolAddress, POOL);
  assert.equal(args.depositSol, p.sizeSol);
  assert.equal(args.below, expectedRange());
  assert.equal(args.above, 0);
  assert.equal(args.shape, "bid_ask");

  assert.equal(calls.executeOpen.length, 1);
  const { meta } = calls.executeOpen[0].opts;
  assert.equal(meta.origin, "auto");
  assert.deepEqual(meta.autoFlip, { pct: 65 }); // ping-pong: hanya flip pertama
  assert.deepEqual(meta.exit.tp, { on: true, pct: p.tpPct });
  assert.equal(meta.strategy.profile, "bidask_flip");
  assert.deepEqual(meta.strategy.params, { ...p });
  assert.equal(meta.strategy.entry.rangePct, expectedRange());
  assert.deepEqual(meta.strategy.entry.poolMeta, { binStep: 100, baseFeePct: 2, protocolFeePct: 5, tvlUsd: 50000 });
  assert.equal(meta.strategy.entry.metrics.feeTvl30mPct, 1.5);
  assert.equal(meta.strategy.entry.metrics.feeActiveTvl30mPct, 1.8);
  assert.equal(meta.strategy.entry.metrics.volatilityPct, 5);
  const sig = meta.strategy.entry.signal;
  assert.deepEqual([sig.reason, sig.candleSource, sig.ath, sig.atl, sig.price], ["signal", "gmgn", 2, 0.5, 1]);
  assert.ok(Math.abs(sig.maxPct - 42.47) < 0.01);

  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0].profile, "bidask_flip");
  assert.equal(calls.notify[0].pair, "AAA-SOL");
  assert.equal(calls.notify[0].pool, POOL);
  assert.equal(calls.notify[0].rangePct, expectedRange());
  assert.equal(calls.notify[0].feeActiveTvl30mPct, 1.8);
});

test("skips non-refundable rent above the cap and too many positions", async () => {
  const p = flipP();
  for (const plan of [
    { positionCount: 1, nonRefundableSol: config.autoEntry.maxNonRefundableSol + 0.01 },
    { positionCount: p.maxPositions + 1, nonRefundableSol: 0 },
    { positionCount: 1, nonRefundableSol: null },
    { error: "range too wide" },
  ]) {
    _resetRunnerForTest();
    const { deps, calls } = makeDeps({
      planOpen: async () => ({ poolAddress: POOL, pair: "AAA-SOL", baseMint: MINT, ...plan }),
    });
    await runScan({ deps });
    assert.equal(calls.executeOpen.length, 0, JSON.stringify(plan));
    assert.equal(calls.failed.length, 0);
  }
});

test("skips when wallet SOL is below size + GAS_RESERVE + 0.08, without counting a failure", async () => {
  const p = flipP();
  const need = p.sizeSol + config.entry.gasReserve + 0.08;
  for (let i = 0; i < config.entry.maxFailures + 1; i++) {
    const { deps, calls } = makeDeps({ getSolBalance: async () => need - 0.001 });
    await runScan({ deps });
    assert.equal(calls.planOpen.length, 0);
    assert.equal(calls.executeOpen.length, 0);
    assert.equal(calls.failed.length + calls.aborted.length, 0);
  }
  const { deps, calls } = makeDeps({ getSolBalance: async () => need + 0.001 });
  await runScan({ deps });
  assert.equal(calls.executeOpen.length, 1, "not blocked: low balance is not a failure");
});

test("token already open in another profile is skipped", async () => {
  const { deps, calls } = makeDeps({
    listOpenTrades: () => [{ id: 9, origin: "auto", baseMint: MINT, strategy: { profile: "other" } }],
  });
  await runScan({ deps });
  assert.equal(calls.fetchTokens.length, 0);
  assert.equal(calls.executeOpen.length, 0);
});

test("manual trade of the same token does not count as an auto open", async () => {
  const { deps, calls } = makeDeps({
    listOpenTrades: () => [{ id: 9, origin: "manual", baseMint: MINT, strategy: null }],
  });
  await runScan({ deps });
  assert.equal(calls.executeOpen.length, 1);
});

test("token closed recently with a loss is in cooldown", async () => {
  const { deps, calls } = makeDeps({
    listClosedTrades: () => [
      { id: 3, origin: "auto", baseMint: MINT, strategy: { profile: "bidask_flip" }, closedAt: NOW - 60_000, closePnlUsd: -5 },
    ],
  });
  await runScan({ deps });
  assert.equal(calls.executeOpen.length, 0);
});

test("pool list failure skips the scan without throwing", async () => {
  const { deps, calls } = makeDeps({
    fetchPoolRows: async (url) => {
      calls.fetchPoolRows.push(url);
      throw new Error("HTTP 500");
    },
  });
  await runScan({ deps });
  assert.equal(calls.fetchPoolRows.length, 1);
  assert.equal(calls.executeOpen.length, 0);
});

test("token / candle failures skip without throwing", async () => {
  const a = makeDeps({ fetchTokens: async () => Promise.reject(new Error("jup down")) });
  await runScan({ deps: a.deps });
  assert.equal(a.calls.executeOpen.length, 0);
  _resetRunnerForTest();
  const b = makeDeps({ fetchRecent5mUsd: async () => ({ bars: [], source: null, error: "GMGN: down · DexPaprika: HTTP 403" }) });
  await runScan({ deps: b.deps });
  assert.equal(b.calls.executeOpen.length, 0);
  assert.equal(getScreenSnapshot()[0].signal, "no_candles");
  assert.match(getScreenSnapshot()[0].detail, /DexPaprika: HTTP 403/);
  _resetRunnerForTest();
  const c = makeDeps({ fetchHistory1hUsd: async () => Promise.reject(new Error("DexPaprika HTTP 403 plan_required")) });
  await runScan({ deps: c.deps });
  assert.equal(c.calls.executeOpen.length, 0);
  assert.equal(getScreenSnapshot()[0].signal, "no_history");
});

test("volatility is fetched once per scan (24h) for the top candidates only", async () => {
  const asked = [];
  const row = (addr, mint, ratio) => ({ ...ROW, address: addr, baseMint: mint, feeActiveTvl30mPct: ratio });
  const { deps } = makeDeps({
    fetchPoolRows: async () => [row("A", "MA", 9), row("B", "MB", 8), row("C", "MC", 7), row("D", "MD", 6)],
    fetchTokens: async (mints) => new Map(mints.map((m) => [m, { ...TOKEN, id: m }])),
    fetchVolatility: async (addresses) => {
      asked.push(addresses);
      return new Map([["A", 7.5]]);
    },
    fetchRecent5mUsd: async () => recent(ABOVE_FIB),
  });
  await runScan({ deps });
  assert.deepEqual(asked, [["A", "B", "C"]]);
  const snap = getScreenSnapshot();
  assert.equal(snap[0].volatilityPct, 7.5);
  assert.deepEqual([snap[1].signal, snap[1].detail], ["volatility", "no 24h volatility from Meteora"]);
});

test("no Meteora volatility skips before any candle request", async () => {
  for (const fetchVolatility of [async () => new Map(), async () => Promise.reject(new Error("HTTP 502"))]) {
    _resetRunnerForTest();
    let fetched = 0;
    const { deps, calls } = makeDeps({
      fetchVolatility,
      fetchRecent5mUsd: async () => {
        fetched++;
        return recent();
      },
    });
    await runScan({ deps });
    assert.equal(fetched, 0);
    assert.equal(calls.planOpen.length, 0);
    assert.equal(getScreenSnapshot()[0].signal, "volatility");
  }
  assert.equal(getScreenSnapshot()[0].detail, "24h volatility failed: HTTP 502");
});

test("history is fetched with the live 5m price as the reference", async () => {
  const seen = [];
  const { deps } = makeDeps({
    fetchHistory1hUsd: async (row, opts) => {
      seen.push([row.address, opts.refUsd]);
      return HISTORY;
    },
  });
  await runScan({ deps });
  assert.deepEqual(seen, [[POOL, 1]]);
});

test("failures: cooldown then block after ENTRY_MAX_FAILURES", async () => {
  const max = config.entry.maxFailures;
  const cooldownMs = config.entry.failureCooldownSec * 1000;
  const { deps, calls, setNow } = makeDeps({
    executeOpen: async (plan, opts) => {
      calls.executeOpen.push({ plan, opts });
      return { success: false, error: "boom" };
    },
  });
  let t = NOW;
  for (let i = 1; i <= max; i++) {
    setNow(t);
    await runScan({ deps });
    assert.equal(calls.executeOpen.length, i);
    if (i < max) {
      // masih cooldown
      setNow(t + cooldownMs - 1000);
      await runScan({ deps });
      assert.equal(calls.executeOpen.length, i, "cooldown blocks a retry");
    }
    t += cooldownMs + 1000;
  }
  assert.equal(calls.failed.length, max - 1);
  assert.equal(calls.failed[0].pool, POOL);
  assert.equal(calls.failed[0].pair, "AAA-SOL");
  assert.equal(calls.failed[0].error, "boom");
  assert.equal(calls.aborted.length, 1);
  assert.equal(calls.aborted[0].attempts, max);

  setNow(t + 10 * cooldownMs);
  await runScan({ deps });
  assert.equal(calls.executeOpen.length, max, "blocked until restart");
});

test("snapshot lists candidates with signal reason", async () => {
  const { deps, calls } = makeDeps({ fetchRecent5mUsd: async () => recent(ABOVE_FIB) });
  await runScan({ deps });
  assert.equal(calls.planOpen.length, 0);
  const snap = getScreenSnapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].profile, "bidask_flip");
  assert.equal(snap[0].pairName, "AAA-SOL");
  assert.equal(snap[0].pool, POOL);
  assert.equal(snap[0].feeTvl30mPct, 1.5);
  assert.equal(snap[0].feeActiveTvl30mPct, 1.8);
  assert.equal(snap[0].volatilityPct, 5);
  assert.equal(snap[0].signal, "above_fib");
});

test("top 3 tokens by fee / active TVL; a repeated token keeps its top pool and the next token fills in", async () => {
  const row = (addr, mint, ratio) => ({ ...ROW, address: addr, baseMint: mint, name: `${addr}-SOL`, feeActiveTvl30mPct: ratio });
  const rows = [row("A2", "MA", 2), row("A1", "MA", 9), row("B", "MB", 8), row("C", "MC", 7), row("D", "MD", 6)];
  const { deps } = makeDeps({
    fetchPoolRows: async () => rows,
    fetchTokens: async (mints) => new Map(mints.map((m) => [m, { ...TOKEN, id: m }])),
    fetchRecent5mUsd: async () => recent(ABOVE_FIB),
  });
  await runScan({ deps });
  assert.deepEqual(getScreenSnapshot().map((c) => c.pool), ["A1", "B", "C"]);
});

test("an empty bar list is labelled no_candles", async () => {
  const { deps, calls } = makeDeps({ fetchRecent5mUsd: async () => ({ bars: [], source: null, error: "no candles" }) });
  await runScan({ deps });
  assert.equal(calls.executeOpen.length, 0);
  assert.equal(getScreenSnapshot()[0].signal, "no_candles");
});

test("DRY_RUN never calls planOpen/executeOpen", async () => {
  const { deps, calls } = makeDeps({ dryRun: true, openPaperTrade: null });
  await runScan({ deps });
  await runScan({ deps });
  assert.equal(calls.planOpen.length, 0);
  assert.equal(calls.executeOpen.length, 0);
  assert.equal(calls.notify.length, 0);
});

test("DRY_RUN uses the openPaperTrade hook when provided", async () => {
  const paper = [];
  const { deps, calls } = makeDeps({ dryRun: true, openPaperTrade: async (a) => paper.push(a) });
  await runScan({ deps });
  assert.equal(paper.length, 1);
  assert.equal(paper[0].profile, "bidask_flip");
  assert.equal(paper[0].rangePct, expectedRange());
  assert.equal(paper[0].strategy.profile, "bidask_flip");
  assert.equal(calls.planOpen.length, 0);
  assert.equal(calls.executeOpen.length, 0);
});

test("Auto Entry turned off mid-scan: no executeOpen", async () => {
  const { deps, calls } = makeDeps({
    planOpen: async (args) => {
      calls.planOpen.push(args);
      setToggle("autoEntry", false);
      return { poolAddress: POOL, pair: "AAA-SOL", baseMint: MINT, positionCount: 1, nonRefundableSol: 0 };
    },
  });
  await runScan({ deps });
  assert.equal(calls.planOpen.length, 1);
  assert.equal(calls.executeOpen.length, 0);
  assert.equal(calls.fetchPoolRows.length, 1);
});

test("Auto Entry off before the open step stops the profile (deps.isOn)", async () => {
  let n = 0;
  // on saat runScan mulai, lalu off saat scanProfile mencapai langkah open
  const { deps, calls } = makeDeps({ isOn: () => n++ < 2 });
  await runScan({ deps });
  assert.equal(calls.fetchPoolRows.length, 1);
  assert.equal(calls.planOpen.length, 0);
  assert.equal(calls.executeOpen.length, 0);
});

test("manual open started mid-scan on the same mint is not raced, no failure counted", async () => {
  const { deps, calls } = makeDeps({
    planOpen: async (args) => {
      calls.planOpen.push(args);
      runtime.addEntryInProgressMint(MINT);
      return { poolAddress: POOL, pair: "AAA-SOL", baseMint: MINT, positionCount: 1, nonRefundableSol: 0 };
    },
  });
  try {
    await runScan({ deps });
  } finally {
    runtime.removeEntryInProgressMint(MINT);
  }
  assert.equal(calls.planOpen.length, 1);
  assert.equal(calls.executeOpen.length, 0);
  assert.equal(calls.failed.length + calls.aborted.length, 0);
  assert.equal(getScreenSnapshot()[0].signal, "in_progress");
});

test("undefined wallet balance is a skip, not a throw", async () => {
  const { deps, calls } = makeDeps({ getSolBalance: async () => undefined });
  await runScan({ deps });
  assert.equal(calls.planOpen.length, 0);
  assert.equal(getScreenSnapshot()[0].signal, "low_balance");
});

// Rem rugi harian: batas default 0.5 SOL.
const brakeLoss = (over) => ({ id: 1, origin: "auto", baseMint: "Other", strategy: { profile: "bidask_flip" }, closedAt: NOW - 60_000, ...over });

test("daily brake: limit hit turns Auto Entry off, alerts once, scans nothing", async () => {
  const brake = [];
  const { deps, calls } = makeDeps({
    listClosedTrades: () => [brakeLoss({ closePnlSol: -0.3 }), brakeLoss({ id: 2, closePnlSol: -0.2 })],
    getSolUsd: async () => 100,
    notifyDailyBrake: (a) => brake.push(a),
  });
  await runScan({ deps });
  assert.equal(config.autoEntry.dailyLossLimitSol, 0.5);
  assert.equal(isOn("autoEntry"), false);
  assert.equal(brake.length, 1);
  assert.ok(Math.abs(brake[0].pnlSol + 0.5) < 1e-9);
  assert.equal(brake[0].limitSol, 0.5);
  assert.equal(calls.fetchPoolRows.length, 0);
  assert.equal(calls.executeOpen.length, 0);
});

test("daily brake: just under the limit scans on", async () => {
  const brake = [];
  const { deps, calls } = makeDeps({
    listClosedTrades: () => [brakeLoss({ closePnlSol: -0.499 })],
    getSolUsd: async () => 100,
    notifyDailyBrake: (a) => brake.push(a),
  });
  await runScan({ deps });
  assert.equal(isOn("autoEntry"), true);
  assert.equal(brake.length, 0);
  assert.equal(calls.fetchPoolRows.length, 1);
});

test("daily brake: converts USD-only losses with the SOL price", async () => {
  const brake = [];
  const { deps } = makeDeps({
    listClosedTrades: () => [brakeLoss({ closePnlUsd: -60 })],
    getSolUsd: async () => 100,
    notifyDailyBrake: (a) => brake.push(a),
  });
  await runScan({ deps });
  assert.equal(isOn("autoEntry"), false);
  assert.equal(brake.length, 1);
});

test("daily brake: no SOL price and USD-only losses today -> scan skipped (fail closed), toggle stays on", async () => {
  for (const getSolUsd of [async () => Promise.reject(new Error("price down")), async () => null]) {
    const brake = [];
    const { deps, calls } = makeDeps({
      listClosedTrades: () => [brakeLoss({ closePnlUsd: -1000 })],
      getSolUsd,
      notifyDailyBrake: (a) => brake.push(a),
    });
    await runScan({ deps });
    assert.equal(isOn("autoEntry"), true);
    assert.equal(brake.length, 0);
    assert.equal(calls.fetchPoolRows.length, 0);
    assert.equal(calls.executeOpen.length, 0);
  }
});

test("daily brake: no SOL price but only SOL-denominated closes -> scan goes ahead", async () => {
  const { deps, calls } = makeDeps({
    listClosedTrades: () => [brakeLoss({ closePnlSol: -0.1, closePnlUsd: -10 })],
    getSolUsd: async () => null,
  });
  await runScan({ deps });
  assert.equal(isOn("autoEntry"), true);
  assert.equal(calls.fetchPoolRows.length, 1);
});

test("daily brake: yesterday's losses (WIB) are ignored", async () => {
  const brake = [];
  const { deps, calls } = makeDeps({
    listClosedTrades: ({ sinceMs }) => [brakeLoss({ closedAt: periodStart("today", NOW) - 1000, closePnlSol: -5 })].filter((t) => t.closedAt >= sinceMs),
    getSolUsd: async () => 100,
    notifyDailyBrake: (a) => brake.push(a),
  });
  await runScan({ deps });
  assert.equal(isOn("autoEntry"), true);
  assert.equal(brake.length, 0);
  assert.equal(calls.fetchPoolRows.length, 1);
});

test("daily brake: manual trades do not count, DRY_RUN has no refs", async () => {
  const brake = [];
  const manual = [brakeLoss({ origin: "manual", strategy: null, closePnlSol: -5 })];
  const a = makeDeps({ listClosedTrades: () => manual, getSolUsd: async () => 100, notifyDailyBrake: (x) => brake.push(x) });
  await runScan({ deps: a.deps });
  const b = makeDeps({
    dryRun: true,
    listClosedTrades: () => [brakeLoss({ closePnlSol: -5 })],
    getSolUsd: async () => 100,
    notifyDailyBrake: (x) => brake.push(x),
  });
  await runScan({ deps: b.deps });
  assert.equal(brake.length, 0);
  assert.equal(isOn("autoEntry"), true);
});

test("daily brake: a throwing dependency does not escape runScan", async () => {
  const brake = [];
  const { deps, calls } = makeDeps({
    notifyDailyBrake: (a) => brake.push(a),
    listClosedTrades: () => {
      throw new Error("state unreadable");
    },
  });
  await runScan({ deps });
  assert.equal(isOn("autoEntry"), true);
  assert.equal(calls.fetchPoolRows.length, 1, "scan went ahead (fail open)");
  assert.equal(brake.length, 0);
});

test("daily brake: a throwing setToggle still stops the scan and still alerts", async () => {
  const brake = [];
  const { deps, calls } = makeDeps({
    listClosedTrades: () => [brakeLoss({ closePnlSol: -0.6 })],
    getSolUsd: async () => 100,
    setToggle: () => {
      throw new Error("disk full");
    },
    notifyDailyBrake: (a) => brake.push(a),
  });
  await runScan({ deps });
  assert.equal(brake.length, 1);
  assert.equal(calls.fetchPoolRows.length, 0);
  assert.equal(calls.executeOpen.length, 0);
});

test("digest: sent after the first scan, then once per TG_STATUS_INTERVAL", async () => {
  const sent = [];
  const { deps, setNow } = makeDeps({
    fetchRecent5mUsd: async () => recent(ABOVE_FIB),
    notifyDigest: (text) => sent.push(text),
  });
  config.tgStatusInterval = 40;
  await runScan({ deps });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Auto Entry digest · first scan · LIVE/);
  assert.match(sent[0], /bidask_flip — 1 scan\(s\)/);
  assert.match(sent[0], /avg\/scan: 1 pools → 1 pass → 1 tokens → 1 checked/);
  assert.match(sent[0], /• AAA-SOL — above_fib: price \$1\.600 · fib 0\.382 \$1\.427 · ATL \$0\.5000 \/ ATH \$2\.000 → price above fib 0\.382 · 5m gmgn/);

  setNow(NOW + 39 * 60_000);
  await runScan({ deps });
  assert.equal(sent.length, 1, "not due yet");
  setNow(NOW + 40 * 60_000);
  await runScan({ deps });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /last 40m/);
  assert.match(sent[1], /bidask_flip — 2 scan\(s\)/);
  assert.match(sent[1], /verdicts: above_fib 2/);
});

test("digest counts pool filter drops and pool list errors", async () => {
  const sent = [];
  const small = makeDeps({ fetchPoolRows: async () => [{ ...ROW, mcapUsd: 1 }], notifyDigest: (t) => sent.push(t) });
  await runScan({ deps: small.deps });
  assert.match(sent[0], /1 pools → 0 pass → 0 tokens → 0 checked/);
  assert.match(sent[0], /verdicts: none/);

  _resetRunnerForTest();
  const down = makeDeps({
    fetchPoolRows: async () => {
      throw new Error("HTTP 500");
    },
    notifyDigest: (t) => sent.push(t),
  });
  await runScan({ deps: down.deps });
  assert.match(sent[1], /bidask_flip — 1 scan\(s\), 1 error\(s\)/);
  assert.match(sent[1], /last error: pool list failed: HTTP 500/);
});

test("snapshot carries the reason detail; entry alert and trade meta carry why entry / why range", async () => {
  const high = makeDeps({ fetchRecent5mUsd: async () => recent(ABOVE_FIB), notifyDigest: () => {} });
  await runScan({ deps: high.deps });
  assert.match(getScreenSnapshot()[0].detail, /price above fib 0\.382/);

  _resetRunnerForTest();
  const { deps, calls } = makeDeps({ notifyDigest: () => {} });
  await runScan({ deps });
  assert.equal(calls.notify.length, 1);
  assert.match(calls.notify[0].signalDetail, /max range 42\.5% \(to fib 0\.786\)/);
  assert.match(calls.notify[0].rangeWhy, /^vol 5\.00\/10 · min 30\.0% · max 42\.5% → 36\.2%$/);
  const entry = calls.executeOpen[0].opts.meta.strategy.entry;
  assert.equal(entry.rangeWhy, calls.notify[0].rangeWhy);
  assert.equal(entry.signalWhy, calls.notify[0].signalDetail);
  assert.equal(getScreenSnapshot()[0].signal, "opened");
});

test("Auto Entry OFF resets the digest window", async () => {
  const sent = [];
  const { deps } = makeDeps({ fetchRecent5mUsd: async () => recent(ABOVE_FIB), notifyDigest: (t) => sent.push(t) });
  await runScan({ deps });
  setToggle("autoEntry", false);
  await runScan({ deps });
  setToggle("autoEntry", true);
  await runScan({ deps });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /first scan/);
});
