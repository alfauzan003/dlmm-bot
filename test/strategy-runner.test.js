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
process.env.BACKTEST_DIR = path.join(TMP, "backtest");
const STRAT = path.join(TMP, "strat.conf");
fs.writeFileSync(STRAT, fs.readFileSync(new URL("../strat.conf", import.meta.url), "utf8"));
process.env.STRAT_FILE = STRAT;

const { default: config } = await import("../src/config/index.js");
const { buildAutoEntry } = await import("../src/strategy/params.js");
const { entrySignal, barsNeeded } = await import("../src/strategy/signal.js");
const { setToggle, isOn } = await import("../src/state/settings.js");
const { periodStart } = await import("../src/lp/pnl-stats.js");
const tg = await import("../src/notify/telegram.js");
const { runScan, getScreenSnapshot, _resetRunnerForTest } = await import("../src/strategy/runner.js");
const runtime = await import("../src/entry/runtime.js");

const NOW = 1_800_000_000_000;
const POOL = "PoolRunner111111111111111111111111111111111";
const MINT = "MintRunner111111111111111111111111111111111";

// Nilai default terkunci (tidak bergantung strat.conf lokal); hanya profil degen yang aktif.
function resetConfig() {
  Object.assign(config.autoEntry, buildAutoEntry({}));
  config.autoEntry.profiles.multihour.on = false;
  config.entry.maxFailures = 3;
  config.entry.failureCooldownSec = 300;
  config.entry.gasReserve = 0.05;
}

// 13 bar 5m tertutup: naik 6 bar (+5%/bar), lalu turun 6 bar merah (-1%/bar) => sinyal pullback.
function makeBars({ lastGreen = false } = {}) {
  const bars = [];
  const startSec = NOW / 1000 - 300 * 14;
  let o = 1;
  for (let i = 0; i < 13; i++) {
    let c;
    if (i === 0) c = 1;
    else if (i <= 6) c = o * 1.05;
    else c = o * 0.99;
    if (i === 12 && lastGreen) c = o * 1.001;
    bars.push({
      time: startSec + i * 300,
      open: o,
      high: Math.max(o, c) * 1.01,
      low: Math.min(o, c) * 0.99,
      close: c,
      volume: 1000,
    });
    o = c;
  }
  return bars;
}

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
};

const TOKEN = {
  id: MINT,
  organicScore: 80,
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
    fetchRecentBars: async () => makeBars(),
    countPoolLps: async () => 50,
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

test("fixture bars form an entry signal", () => {
  const p = config.autoEntry.profiles.degen;
  assert.equal(entrySignal(makeBars(), p).enter, true);
  assert.equal(entrySignal(makeBars({ lastGreen: true }), p).reason, "not_red");
  assert.ok(makeBars().length >= barsNeeded(p));
});

test("runScan does nothing when Auto Entry is off", async () => {
  setToggle("autoEntry", false);
  const { deps, calls } = makeDeps();
  await runScan({ deps });
  assert.equal(calls.fetchPoolRows.length, 0);
});

test("happy path opens one live trade with auto meta", async () => {
  const p = config.autoEntry.profiles.degen;
  const { deps, calls } = makeDeps();
  await runScan({ deps });

  assert.equal(calls.fetchPoolRows.length, 1, "multihour off => one profile scanned");
  assert.ok(calls.fetchPoolRows[0].startsWith("https://dlmm.datapi.meteora.ag/pools?"));
  assert.equal(calls.planOpen.length, 1);
  const args = calls.planOpen[0];
  assert.equal(args.poolAddress, POOL);
  assert.equal(args.depositSol, p.sizeSol);
  assert.equal(args.below, p.rangePct);
  assert.equal(args.above, 0);
  assert.equal(args.shape, "bid_ask");

  assert.equal(calls.executeOpen.length, 1);
  const { meta } = calls.executeOpen[0].opts;
  assert.equal(meta.origin, "auto");
  assert.equal(meta.autoFlip.pct, p.flipPct);
  assert.deepEqual(meta.exit.tp, { on: true, pct: p.tpPct });
  assert.equal(meta.strategy.profile, "degen");
  assert.deepEqual(meta.strategy.params, { ...p });
  assert.equal(meta.strategy.entry.rangePct, p.rangePct);
  assert.deepEqual(meta.strategy.entry.poolMeta, { binStep: 100, baseFeePct: 2, protocolFeePct: 5, tvlUsd: 50000 });
  assert.equal(meta.strategy.entry.metrics.feeTvl30mPct, 1.5);
  assert.equal(meta.strategy.entry.metrics.lps, 50);
  assert.ok(meta.strategy.entry.metrics.volatilityPct > 2);
  assert.equal(meta.strategy.entry.signal.reason, "signal");
  assert.ok(meta.strategy.entry.signal.pumpPct > 20);

  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0].profile, "degen");
  assert.equal(calls.notify[0].pair, "AAA-SOL");
  assert.equal(calls.notify[0].pool, POOL);
  assert.equal(calls.notify[0].rangePct, p.rangePct);
});

test("skips non-refundable rent above the cap and too many positions", async () => {
  const p = config.autoEntry.profiles.degen;
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
  const p = config.autoEntry.profiles.degen;
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
    listOpenTrades: () => [{ id: 9, origin: "auto", baseMint: MINT, strategy: { profile: "multihour" } }],
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
      { id: 3, origin: "auto", baseMint: MINT, strategy: { profile: "degen" }, closedAt: NOW - 60_000, closePnlUsd: -5 },
    ],
  });
  await runScan({ deps });
  assert.equal(calls.executeOpen.length, 0);
});

test("datapi failure skips the profile without throwing", async () => {
  config.autoEntry.profiles.multihour.on = true;
  let n = 0;
  const { deps, calls } = makeDeps({
    fetchPoolRows: async (url) => {
      calls.fetchPoolRows.push(url);
      if (n++ === 0) throw new Error("HTTP 500");
      return [];
    },
  });
  await runScan({ deps });
  assert.equal(calls.fetchPoolRows.length, 2, "second profile still scanned");
  assert.equal(calls.executeOpen.length, 0);
});

test("token / candle failures skip without throwing", async () => {
  const a = makeDeps({ fetchTokens: async () => Promise.reject(new Error("jup down")) });
  await runScan({ deps: a.deps });
  assert.equal(a.calls.executeOpen.length, 0);
  const b = makeDeps({ fetchRecentBars: async () => Promise.reject(new Error("ohlcv down")) });
  await runScan({ deps: b.deps });
  assert.equal(b.calls.executeOpen.length, 0);
});

test("LP count below MIN_LPS or unknown skips", async () => {
  for (const lps of [3, null]) {
    _resetRunnerForTest();
    const { deps, calls } = makeDeps({ countPoolLps: async () => lps });
    await runScan({ deps });
    assert.equal(calls.planOpen.length, 0, String(lps));
  }
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
  const { deps, calls } = makeDeps({ fetchRecentBars: async () => makeBars({ lastGreen: true }) });
  await runScan({ deps });
  assert.equal(calls.planOpen.length, 0);
  const snap = getScreenSnapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].profile, "degen");
  assert.equal(snap[0].pairName, "AAA-SOL");
  assert.equal(snap[0].pool, POOL);
  assert.equal(snap[0].feeTvl30mPct, 1.5);
  assert.ok(snap[0].volatilityPct > 2);
  assert.equal(snap[0].signal, "not_red");
});

// Bar mentah Meteora untuk pool SOL = X: token per SOL (kebalikan SOL per token).
const rawSolAsX = () => makeBars().map((b) => ({ ...b, open: 1 / b.open, high: 1 / b.low, low: 1 / b.high, close: 1 / b.close }));

test("SOL-as-X pool: raw token-per-SOL bars are inverted before the signal", async () => {
  const fetched = [];
  const { deps, calls } = makeDeps({
    fetchPoolRows: async () => [{ ...ROW, baseIsX: false }],
    fetchRecentBars: async (pool, limit) => {
      fetched.push({ pool, limit });
      return rawSolAsX();
    },
  });
  await runScan({ deps });
  assert.deepEqual(fetched, [{ pool: POOL, limit: barsNeeded(config.autoEntry.profiles.degen) + 1 }]);
  assert.equal(calls.executeOpen.length, 1, "pump + pullback seen after normalization");
});

test("token-as-X pool: the same raw bars are not inverted (control)", async () => {
  const { deps, calls } = makeDeps({ fetchRecentBars: async () => rawSolAsX() });
  await runScan({ deps });
  assert.equal(calls.executeOpen.length, 0, "inverted series shows a dump, not a pump");
});

test("an empty bar list is labelled no_candles", async () => {
  const { deps, calls } = makeDeps({ fetchRecentBars: async () => [] });
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
  assert.equal(paper[0].profile, "degen");
  assert.equal(paper[0].rangePct, config.autoEntry.profiles.degen.rangePct);
  assert.equal(paper[0].strategy.profile, "degen");
  assert.equal(calls.planOpen.length, 0);
  assert.equal(calls.executeOpen.length, 0);
});

test("Auto Entry turned off mid-scan: no executeOpen, second profile not scanned", async () => {
  config.autoEntry.profiles.multihour.on = true;
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
  assert.equal(calls.fetchPoolRows.length, 1, "multihour not scanned after the toggle went off");
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
const brakeLoss = (over) => ({ id: 1, origin: "auto", baseMint: "Other", strategy: { profile: "degen" }, closedAt: NOW - 60_000, ...over });

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
    fetchRecentBars: async () => makeBars({ lastGreen: true }),
    notifyDigest: (text) => sent.push(text),
  });
  config.tgStatusInterval = 40;
  await runScan({ deps });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Auto Entry digest · first scan · LIVE/);
  assert.match(sent[0], /degen — 1 scan\(s\)/);
  assert.match(sent[0], /avg\/scan: 1 pools → 1 pass → 1 tokens → 1 checked/);
  assert.match(sent[0], /• AAA-SOL — not_red: pump [\d.]+% · pullback [\d.]+% · last bar not red/);

  setNow(NOW + 39 * 60_000);
  await runScan({ deps });
  assert.equal(sent.length, 1, "not due yet");
  setNow(NOW + 40 * 60_000);
  await runScan({ deps });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /last 40m/);
  assert.match(sent[1], /degen — 2 scan\(s\)/);
  assert.match(sent[1], /verdicts: not_red 2/);
});

test("digest counts pool filter drops and pool list errors", async () => {
  const sent = [];
  const small = makeDeps({ fetchPoolRows: async () => [{ ...ROW, tvlUsd: 1 }], notifyDigest: (t) => sent.push(t) });
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
  assert.match(sent[1], /degen — 1 scan\(s\), 1 error\(s\)/);
  assert.match(sent[1], /last error: pool list failed: HTTP 500/);
});

test("snapshot carries the reason detail; entry alert and trade meta carry why entry / why range", async () => {
  const red = makeDeps({ fetchRecentBars: async () => makeBars({ lastGreen: true }), notifyDigest: () => {} });
  await runScan({ deps: red.deps });
  assert.match(getScreenSnapshot()[0].detail, /last bar not red/);

  _resetRunnerForTest();
  const { deps, calls } = makeDeps({ notifyDigest: () => {} });
  await runScan({ deps });
  assert.equal(calls.notify.length, 1);
  assert.match(calls.notify[0].signalDetail, /last bar red/);
  assert.match(calls.notify[0].rangeWhy, /^(fixed|support mode)/);
  const entry = calls.executeOpen[0].opts.meta.strategy.entry;
  assert.equal(entry.rangeWhy, calls.notify[0].rangeWhy);
  assert.equal(entry.signalWhy, calls.notify[0].signalDetail);
  assert.equal(getScreenSnapshot()[0].signal, "opened");
});

test("Auto Entry OFF resets the digest window", async () => {
  const sent = [];
  const { deps } = makeDeps({ fetchRecentBars: async () => makeBars({ lastGreen: true }), notifyDigest: (t) => sent.push(t) });
  await runScan({ deps });
  setToggle("autoEntry", false);
  await runScan({ deps });
  setToggle("autoEntry", true);
  await runScan({ deps });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /first scan/);
});
