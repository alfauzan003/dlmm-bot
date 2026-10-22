import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Semua file runtime ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-paper-"));
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
const { setToggle } = await import("../src/state/settings.js");
const tg = await import("../src/notify/telegram.js");
const { PAPER_FILE } = await import("../src/core/paths.js");
const { openPaperTrade, tickPaperTrades, listPaperTrades, paperLogRow, fillGaps } = await import("../src/strategy/paper.js");
const { runScan, _resetRunnerForTest } = await import("../src/strategy/runner.js");

const NOW = 1_800_000_000_000; // kelipatan 300000 ms
const OPENED = NOW + 60_000; // di tengah bar 5m -> entryBarTime = bar berikutnya
const ENTRY_BAR = NOW / 1000 + 300;
const POOL = "PoolPaper1111111111111111111111111111111111";
const MINT = "MintPaper1111111111111111111111111111111111";

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

const ENTRY = {
  metrics: { feeTvl30mPct: 1.5, volume30mUsd: 50000, tvlUsd: 50000, mcapUsd: 1_000_000, volatilityPct: 3 },
  signal: { reason: "pullback" },
  rangePct: 50,
  poolMeta: { binStep: 100, baseFeePct: 2, protocolFeePct: 5, tvlUsd: 50000 },
};

function degen() {
  return config.autoEntry.profiles.degen;
}

// SL desaktif: dump di tes hanya boleh ditutup oleh exit strategi (range_broken).
const noSl = () => ({ ...degen(), slPct: 0 });

// Bin dengan likuiditas: base = X (token, 6 desimal), SOL = Y (9 desimal). pricePerToken = SOL per token.
function fakePool(activeId = 100) {
  return {
    getActiveBin: async () => ({ binId: activeId, price: "1", pricePerToken: "1" }),
    getBinsBetweenLowerAndUpperBound: async (lo, hi) => ({
      activeBin: activeId,
      bins: Array.from({ length: hi - lo + 1 }, (_, i) => ({
        binId: lo + i,
        xAmount: { toString: () => "2000000" }, // 2 token
        yAmount: { toString: () => "3000000000" }, // 3 SOL
        pricePerToken: "0.5",
      })),
    }),
  };
}

function makeDeps(over = {}) {
  const calls = { entry: [], close: [], log: [], candles: [] };
  const deps = {
    now: () => NOW + 3_600_000,
    getPoolInfo: async () => ({ pool: fakePool(), baseIsX: true }),
    getMintDecimals: async () => 6,
    getSolUsd: async () => 100,
    fetchCandles: async () => [],
    notifyEntry: (a) => calls.entry.push(a),
    notifyClose: (t) => calls.close.push(t),
    log: (row) => calls.log.push(row),
    ...over,
  };
  return { deps, calls };
}

// Bar flat di harga 1 (bar entry), lalu dump ke 0.3 (jauh di bawah range -50%).
function dumpBars(count = 8) {
  const bars = [{ time: ENTRY_BAR, open: 1, high: 1, low: 1, close: 1, volume: 1000 }];
  for (let i = 1; i < count; i++) {
    const open = i === 1 ? 1 : 0.3;
    bars.push({ time: ENTRY_BAR + i * 300, open, high: open, low: 0.3, close: 0.3, volume: 1000 });
  }
  return bars;
}

test.beforeEach(() => {
  fs.rmSync(PAPER_FILE, { force: true });
  fs.rmSync(process.env.SETTINGS_FILE, { force: true });
  setToggle("autoEntry", true);
  Object.assign(config.autoEntry, buildAutoEntry({}));
  config.autoEntry.profiles.multihour.on = false;
  _resetRunnerForTest();
  tg.__setSender(async () => null);
});

test.after(() => {
  tg.__setSender(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("openPaperTrade stores entryBarTime, pool meta and per-bin liquidity", async () => {
  const { deps, calls } = makeDeps({ now: () => OPENED });
  const t = await openPaperTrade({ profile: "degen", p: degen(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  assert.equal(t.id, "P1");
  assert.equal(t.entryBarTime, ENTRY_BAR);
  assert.equal(t.openedAt, OPENED);
  assert.equal(t.closed, false);
  assert.deepEqual(t.poolMeta, ENTRY.poolMeta);
  assert.equal(t.pair, "AAA-SOL");
  assert.equal(t.baseMint, MINT);
  assert.equal(t.rangePct, 50);
  // baseIsX: k = binId - activeId; tiap bin = 3 SOL + 2 token * 0.5 SOL = 4 SOL.
  assert.equal(t.poolLiq["0"], 4);
  assert.equal(t.poolLiq["-10"], 4);
  assert.ok(Object.keys(t.poolLiq).every((k) => Number(k) <= 0));
  assert.deepEqual(listPaperTrades({ open: true }).map((x) => x.id), ["P1"]);
  assert.equal(calls.entry.length, 1);
  assert.equal(calls.entry[0].paper, true);
  assert.equal(calls.entry[0].pair, "AAA-SOL");
  assert.equal(calls.entry[0].sizeSol, degen().sizeSol);
  const second = await openPaperTrade({ profile: "degen", p: degen(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  assert.equal(second.id, "P2");
});

test("openPaperTrade with SOL as X reverses k and prices", async () => {
  const { deps } = makeDeps({
    now: () => OPENED,
    getPoolInfo: async () => ({ pool: fakePool(100), baseIsX: false }),
  });
  const t = await openPaperTrade({
    profile: "degen",
    p: degen(),
    row: { ...ROW, baseIsX: false },
    rangePct: 50,
    entry: ENTRY,
    deps,
  });
  // X = SOL (9 desimal) 2e6 -> 0.002 SOL; Y = token (6 desimal) 3e9 -> 3000 token * (1 / 0.5) SOL.
  assert.ok(Math.abs(t.poolLiq["0"] - (0.002 + 6000)) < 1e-9);
  assert.ok(Object.keys(t.poolLiq).every((k) => Number(k) <= 0));
});

test("RPC failure while reading bins → empty poolLiq, trade still opens", async () => {
  const { deps, calls } = makeDeps({
    now: () => OPENED,
    getPoolInfo: async () => {
      throw new Error("rpc down");
    },
  });
  const t = await openPaperTrade({ profile: "degen", p: degen(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  assert.deepEqual(t.poolLiq, {});
  assert.equal(listPaperTrades().length, 1);
  assert.equal(calls.entry.length, 1);
});

test("tick with no new bars leaves the trade open", async () => {
  const { deps, calls } = makeDeps({ now: () => OPENED });
  await openPaperTrade({ profile: "degen", p: degen(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  const tick = makeDeps({ now: () => OPENED + 60_000, fetchCandles: async () => [] });
  const closed = await tickPaperTrades({ deps: tick.deps });
  assert.deepEqual(closed, []);
  assert.equal(listPaperTrades({ open: true }).length, 1);
  assert.equal(calls.close.length, 0);
});

test("tick skips when SOL price is unavailable", async () => {
  const { deps } = makeDeps({ now: () => OPENED });
  await openPaperTrade({ profile: "degen", p: degen(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  const tick = makeDeps({
    fetchCandles: async () => dumpBars(),
    getSolUsd: async () => {
      throw new Error("price down");
    },
  });
  assert.deepEqual(await tickPaperTrades({ deps: tick.deps }), []);
  assert.equal(listPaperTrades({ open: true }).length, 1);
});

test("tick closes on a strategy exit and logs + notifies once", async () => {
  const { deps } = makeDeps({ now: () => OPENED });
  await openPaperTrade({ profile: "degen", p: noSl(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  const tick = makeDeps({
    fetchCandles: async (mint, pool, opts) => {
      tick.calls.candles.push({ mint, pool, opts });
      return dumpBars();
    },
  });
  const closed = await tickPaperTrades({ deps: tick.deps });
  assert.equal(closed.length, 1);
  const t = listPaperTrades()[0];
  assert.equal(t.closed, true);
  assert.equal(t.closeReason, "range_broken");
  assert.ok(t.closePnlSol < 0);
  assert.ok(t.closePnlPct < 0);
  assert.ok(t.closedAt > t.openedAt);
  assert.equal(typeof t.holdMin, "number");
  assert.equal(typeof t.flipped, "boolean");
  assert.equal(tick.calls.candles[0].opts.resolution, "5m");
  assert.equal(tick.calls.close.length, 1);
  assert.equal(tick.calls.log.length, 1);
  assert.equal(tick.calls.log[0].id, "P1");
  assert.equal(listPaperTrades({ open: false }).length, 1);
  assert.equal(listPaperTrades({ open: true }).length, 0);

  const again = await tickPaperTrades({ deps: tick.deps });
  assert.deepEqual(again, []);
  assert.equal(tick.calls.close.length, 1, "no second notify");
  assert.equal(tick.calls.log.length, 1, "no second log row");
});

test("a fetch with only the latest bars still simulates from the stored entry bar", async () => {
  const { deps } = makeDeps({ now: () => OPENED });
  await openPaperTrade({ profile: "degen", p: noSl(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  const all = dumpBars();
  // tick 1: belum cukup untuk exit (entry + 1 bar), riwayat tersimpan
  const t1 = makeDeps({ now: () => ENTRY_BAR * 1000 + 2 * 300_000, fetchCandles: async () => all.slice(0, 2) });
  assert.deepEqual(await tickPaperTrades({ deps: t1.deps }), []);
  assert.equal(listPaperTrades()[0].bars.length, 2);
  // tick 2: cache pendek hanya mengembalikan bar terakhir; bar entry diambil dari riwayat
  const t2 = makeDeps({ fetchCandles: async () => all.slice(-3) });
  const closed = await tickPaperTrades({ deps: t2.deps });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closeReason, "range_broken");
  assert.equal(listPaperTrades()[0].bars[0].time, ENTRY_BAR);
  // p0 = open bar entry (1): kerugian besar, bukan nilai dari bar lanjutan
  assert.ok(closed[0].closePnlPct < 0);
});

test("bars missing at the entry are not simulated until the entry bar arrives", async () => {
  const { deps } = makeDeps({ now: () => OPENED });
  await openPaperTrade({ profile: "degen", p: noSl(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  const all = dumpBars();
  const late = makeDeps({ fetchCandles: async () => all.slice(3) });
  assert.deepEqual(await tickPaperTrades({ deps: late.deps }), []);
  assert.equal(listPaperTrades({ open: true }).length, 1);
  const full = makeDeps({ fetchCandles: async () => all });
  assert.equal((await tickPaperTrades({ deps: full.deps })).length, 1);
});

test("a gap between stored bars is filled with a flat zero-volume bar", async () => {
  const { deps } = makeDeps({ now: () => OPENED });
  await openPaperTrade({ profile: "degen", p: noSl(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  const all = dumpBars();
  const withGap = all.filter((b) => b.time !== ENTRY_BAR + 300); // bar 1 hilang
  const tick = makeDeps({ fetchCandles: async () => withGap });
  const closed = await tickPaperTrades({ deps: tick.deps });
  assert.equal(closed.length, 1);
  // bar isian: datar di close sebelumnya, volume 0; hanya bar nyata yang disimpan
  const filled = fillGaps(withGap, ENTRY_BAR);
  assert.equal(filled.length, all.length);
  assert.deepEqual(filled[1], { time: ENTRY_BAR + 300, open: 1, high: 1, low: 1, close: 1, volume: 0 });
  assert.equal(fillGaps(withGap.slice(1), ENTRY_BAR), null);
  // riwayat yang disimpan hanya bar nyata (bar isian tidak disimpan)
  assert.equal(listPaperTrades()[0].bars.length, withGap.length);
});

test("a first bar with open = 0 does not close the trade", async () => {
  const { deps } = makeDeps({ now: () => OPENED });
  await openPaperTrade({ profile: "degen", p: noSl(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  const bad = dumpBars();
  bad[0] = { ...bad[0], open: 0 };
  const tick = makeDeps({ fetchCandles: async () => bad });
  assert.deepEqual(await tickPaperTrades({ deps: tick.deps }), []);
  assert.equal(listPaperTrades({ open: true }).length, 1);
  assert.equal(tick.calls.close.length, 0);
});

test("token decimals come from the pool object, not getMintDecimals", async () => {
  const pool = { ...fakePool(), tokenX: { mint: { decimals: 6 } }, tokenY: { mint: { decimals: 9 } } };
  const { deps } = makeDeps({
    now: () => OPENED,
    getPoolInfo: async () => ({ pool, baseIsX: true }),
    getMintDecimals: async () => 9, // nilai default salah saat RPC error
  });
  const t = await openPaperTrade({ profile: "degen", p: degen(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  assert.equal(t.poolLiq["0"], 4); // 2e6 / 1e6 token * 0.5 + 3 SOL
});

test("paperLogRow carries the closed trade fields", async () => {
  const { deps } = makeDeps({ now: () => OPENED });
  await openPaperTrade({ profile: "degen", p: noSl(), row: ROW, rangePct: 50, entry: ENTRY, deps });
  await tickPaperTrades({ deps: makeDeps({ fetchCandles: async () => dumpBars() }).deps });
  const row = paperLogRow(listPaperTrades()[0]);
  assert.equal(row.id, "P1");
  assert.equal(row.closeReason, "range_broken");
  assert.equal(row.profile, "degen");
});

test("notifyPaperClose text", () => {
  const sent = [];
  tg.__setSender(async (text) => sent.push(text));
  tg.notifyPaperClose({
    profile: "degen",
    pair: "AAA-SOL",
    closeReason: "range_broken",
    closePnlPct: -12.345,
    closePnlSol: -0.06172,
    holdMin: 42.4,
    flipped: true,
  });
  tg.notifyPaperClose({
    profile: "degen",
    pair: "AAA-SOL",
    closeReason: "cycle_done",
    closePnlPct: 3,
    closePnlSol: 0.015,
    holdMin: 10,
    flipped: false,
  });
  assert.equal(
    sent[0],
    "📝 PAPER close · degen · AAA-SOL\nReason: Range broken\nPnL: -12.35% (-0.0617 SOL) · 42m · flipped"
  );
  assert.equal(sent[1], "📝 PAPER close · degen · AAA-SOL\nReason: Cycle done\nPnL: +3.00% (+0.0150 SOL) · 10m");
});

// 13 bar 5m tertutup: naik 6 bar, turun 6 bar merah => sinyal pullback (sama dengan tes runner).
function signalBars() {
  const bars = [];
  const startSec = NOW / 1000 - 300 * 14;
  let o = 1;
  for (let i = 0; i < 13; i++) {
    const c = i === 0 ? 1 : i <= 6 ? o * 1.05 : o * 0.99;
    bars.push({ time: startSec + i * 300, open: o, high: Math.max(o, c) * 1.01, low: Math.min(o, c) * 0.99, close: c, volume: 1000 });
    o = c;
  }
  return bars;
}

const TOKEN_INFO = (mint) => ({
  id: mint,
  organicScore: 80,
  audit: { topHoldersPercentage: 10, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
});

test("runner in DRY_RUN opens paper trades and counts them for maxOpen", async () => {
  degen().maxOpen = 1;
  const MINT2 = "MintPaper2222222222222222222222222222222222";
  const ROW2 = { ...ROW, address: "PoolPaper2222222222222222222222222222222222", baseMint: MINT2, name: "BBB-SOL" };
  const placed = [];
  const deps = {
    now: () => NOW,
    dryRun: true,
    fetchPoolRows: async () => [ROW, ROW2],
    fetchTokens: async (mints) => new Map(mints.map((m) => [m, TOKEN_INFO(m)])),
    fetchCandles: async () => signalBars(),
    countPoolLps: async () => 50,
    listOpenTrades: () => [],
    listClosedTrades: () => [],
    getSolUsd: async () => 100,
    paper: makeDeps({ now: () => NOW, notifyEntry: (a) => placed.push(a) }).deps,
  };
  await runScan({ deps });
  assert.equal(listPaperTrades({ open: true }).length, 1, "maxOpen=1 stops the second pool");
  assert.equal(placed.length, 1);
  assert.equal(placed[0].paper, true);
  await runScan({ deps });
  assert.equal(listPaperTrades().length, 1, "open paper trade counted on the next scan");
});

test("runner in DRY_RUN: closed paper loss feeds the daily brake and the cooldown", async () => {
  const { deps: pd } = makeDeps({ now: () => NOW });
  await openPaperTrade({ profile: "degen", p: noSl(), row: ROW, rangePct: 50, entry: ENTRY, deps: pd });
  // paksa close di hari ini (WIB): tick dengan bar dump, now = NOW + 1 jam
  await tickPaperTrades({ deps: makeDeps({ now: () => NOW + 3_600_000, fetchCandles: async () => dumpBars() }).deps });
  const closed = listPaperTrades({ open: false });
  assert.equal(closed.length, 1);
  config.autoEntry.dailyLossLimitSol = 0.001;
  const brake = [];
  const calls = { fetchPoolRows: 0 };
  await runScan({
    deps: {
      now: () => closed[0].closedAt + 1000,
      dryRun: true,
      fetchPoolRows: async () => {
        calls.fetchPoolRows++;
        return [ROW];
      },
      getSolUsd: async () => 100,
      notifyDailyBrake: (x) => brake.push(x),
    },
  });
  assert.equal(brake.length, 1);
  assert.equal(calls.fetchPoolRows, 0, "scan stopped by the brake");
});
