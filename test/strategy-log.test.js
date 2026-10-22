import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Semua file runtime ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-slog-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");
process.env.PAPER_FILE = path.join(TMP, "paper-trades.json");
process.env.STRATEGY_LOG_FILE = path.join(TMP, "strategy-log.jsonl");
process.env.BACKTEST_DIR = path.join(TMP, "backtest");
const STRAT = path.join(TMP, "strat.conf");
fs.writeFileSync(STRAT, fs.readFileSync(new URL("../strat.conf", import.meta.url), "utf8"));
process.env.STRAT_FILE = STRAT;

const { default: config } = await import("../src/config/index.js");
const { STRATEGY_LOG_FILE } = await import("../src/core/paths.js");
const { appendStrategyLog, readStrategyLog, logSettledAutoTrades, summarizeRows, paperLogRow, DEPTH_FACTORS } = await import(
  "../src/strategy/log.js"
);

const OPENED = 1_800_000_000_000 + 60_000; // di tengah bar 5m
const CLOSED = OPENED + 20 * 60_000;
const FIRST_BAR = 1_800_000_000 + 300; // bar pertama pada/setelah OPENED

function trade(over = {}) {
  return {
    id: 7,
    origin: "auto",
    pool: "PoolLog1111111111111111111111111111111111111",
    pair: "AAA-SOL",
    baseMint: "MintLog1111111111111111111111111111111111111",
    openedAt: OPENED,
    closedAt: CLOSED,
    closed: true,
    closePnlUsd: 5,
    closePnlPct: 4.2,
    closeReason: "cycle_done",
    flipLegs: ["leg"],
    strategy: {
      profile: "degen",
      params: { ...config.autoEntry.profiles.degen },
      entry: { metrics: { feeTvl30mPct: 3 }, signal: null, rangePct: 50, poolMeta: { binStep: 100, baseFeePct: 2, protocolFeePct: 5, tvlUsd: 50000 } },
    },
    ...over,
  };
}

// Bar datar di harga 1 (SOL per token, SOL = Y) dari FIRST_BAR; plus satu bar sebelum OPENED yang harus dibuang.
function flatBars() {
  const bars = [{ time: FIRST_BAR - 300, open: 9, high: 9, low: 9, close: 9, volume: 1000 }];
  for (let i = 0; i < 30; i++) bars.push({ time: FIRST_BAR + i * 300, open: 1, high: 1.01, low: 0.99, close: 1, volume: 1000 });
  return bars;
}

function makeDeps(trades, over = {}) {
  const calls = { rows: [], marked: [], ranges: [] };
  const deps = {
    listClosedTrades: () => trades,
    markLogged: (id) => calls.marked.push(id),
    getSolUsd: async () => 100,
    getBaseIsX: async () => true,
    fetchOhlcvRange: async (pool, s, e) => {
      calls.ranges.push({ pool, s, e });
      return flatBars();
    },
    append: (row) => calls.rows.push(row),
    ...over,
  };
  return { deps, calls };
}

test("append/read round trip skips bad lines", () => {
  assert.deepEqual(readStrategyLog(), []); // belum ada file
  appendStrategyLog({ mode: "live", pnlPct: 1 });
  fs.appendFileSync(STRATEGY_LOG_FILE, "{bad json\n\n");
  appendStrategyLog({ mode: "paper", pnlPct: -2 });
  const rows = readStrategyLog();
  assert.deepEqual(rows, [
    { mode: "live", pnlPct: 1 },
    { mode: "paper", pnlPct: -2 },
  ]);
  fs.rmSync(STRATEGY_LOG_FILE);
});

test("logSettledAutoTrades waits 2 minutes, writes one row with 5 predictions, marks logged", async () => {
  const { deps, calls } = makeDeps([trade()]);
  assert.equal(await logSettledAutoTrades({ deps, now: CLOSED + 119_000 }), 0);
  assert.equal(calls.rows.length, 0);

  assert.equal(await logSettledAutoTrades({ deps, now: CLOSED + 120_000 }), 1);
  assert.equal(calls.rows.length, 1);
  assert.deepEqual(calls.marked, [7]);
  const row = calls.rows[0];
  assert.equal(row.mode, "live");
  assert.equal(row.ts, CLOSED);
  assert.equal(row.profile, "degen");
  assert.equal(row.pair, "AAA-SOL");
  assert.equal(row.mint, "MintLog1111111111111111111111111111111111111");
  assert.equal(row.pnlPct, 4.2);
  assert.equal(row.pnlSol, 0.05); // 5 USD / 100
  assert.equal(row.holdMin, 20);
  assert.equal(row.flipped, true);
  assert.equal(row.exitReason, "cycle_done");
  assert.equal(row.entry.rangePct, 50);
  assert.deepEqual(Object.keys(row.predicted).map(Number).sort((a, b) => a - b), DEPTH_FACTORS);
  for (const f of DEPTH_FACTORS) assert.ok(Number.isFinite(row.predicted[f]));
  // jendela bar mencakup seluruh hold (+/- 5 menit)
  assert.deepEqual(calls.ranges, [{ pool: trade().pool, s: OPENED / 1000 - 300, e: CLOSED / 1000 + 300 }]);
});

test("skips non-auto, already logged and no-strategy trades", async () => {
  const list = [trade({ origin: "manual" }), trade({ id: 8, strategyLogged: true }), trade({ id: 9, strategy: undefined })];
  const { deps, calls } = makeDeps(list);
  assert.equal(await logSettledAutoTrades({ deps, now: CLOSED + 10 * 60_000 }), 0);
  assert.equal(calls.rows.length, 0);
});

test("waits for closePnlPct up to 30 minutes, then writes pnlPct null", async () => {
  const { deps, calls } = makeDeps([trade({ closePnlPct: null })]);
  assert.equal(await logSettledAutoTrades({ deps, now: CLOSED + 29 * 60_000 }), 0);
  assert.equal(await logSettledAutoTrades({ deps, now: CLOSED + 30 * 60_000 }), 1);
  assert.equal(calls.rows[0].pnlPct, null);
  assert.deepEqual(calls.marked, [7]);
});

test("candle failure still writes the row with predicted null", async () => {
  const { deps, calls } = makeDeps([trade()], {
    fetchOhlcvRange: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(await logSettledAutoTrades({ deps, now: CLOSED + 130_000 }), 1);
  assert.equal(calls.rows[0].predicted, null);
  assert.equal(calls.rows[0].pnlPct, 4.2);
  assert.deepEqual(calls.marked, [7]);
});

test("unknown orientation or SOL price failure -> predicted null / pnlSol null", async () => {
  const a = makeDeps([trade()], { getBaseIsX: async () => undefined });
  await logSettledAutoTrades({ deps: a.deps, now: CLOSED + 130_000 });
  assert.equal(a.calls.rows[0].predicted, null);
  assert.equal(a.calls.rows[0].pnlSol, 0.05);

  const b = makeDeps([trade()], {
    getSolUsd: async () => {
      throw new Error("no price");
    },
  });
  await logSettledAutoTrades({ deps: b.deps, now: CLOSED + 130_000 });
  assert.equal(b.calls.rows[0].pnlSol, null);
  assert.equal(b.calls.rows[0].predicted, null);
});

test("a failed write leaves the trade unmarked so it is retried", async () => {
  const { deps, calls } = makeDeps([trade()], {
    append: () => {
      throw new Error("disk");
    },
  });
  assert.equal(await logSettledAutoTrades({ deps, now: CLOSED + 130_000 }), 0);
  assert.deepEqual(calls.marked, []);
});

test("paperLogRow maps a closed paper trade", () => {
  const row = paperLogRow({
    id: "P1",
    profile: "degen",
    pool: "pool",
    pair: "AAA-SOL",
    baseMint: "mint",
    p: { rangePct: 50 },
    entry: { metrics: null, signal: null },
    closedAt: 123,
    closePnlSol: -0.1,
    closePnlPct: -20,
    holdMin: 12,
    flipped: false,
    closeReason: "range_broken",
  });
  assert.deepEqual(row, {
    ts: 123,
    mode: "paper",
    profile: "degen",
    pool: "pool",
    pair: "AAA-SOL",
    mint: "mint",
    params: { rangePct: 50 },
    entry: { metrics: null, signal: null },
    pnlPct: -20,
    pnlSol: -0.1,
    holdMin: 12,
    flipped: false,
    exitReason: "range_broken",
    predicted: null,
  });
});

test("summarizeRows groups, buckets and picks the lowest-MAE factor", () => {
  const live = (pnl, pred) => ({
    mode: "live",
    profile: "degen",
    pnlPct: pnl,
    params: { rangePct: 50, flipPct: 60 },
    flipped: false,
    holdMin: 10,
    exitReason: "tp",
    predicted: pred,
  });
  const s = summarizeRows([live(5, { 0.25: 9, 0.5: 6, 1: 4, 2: 2, 4: 1 }), live(3, { 0.25: 8, 0.5: 3.5, 1: 2, 2: 1, 4: 0 })]);
  assert.equal(s.calibration.factor, 0.5);
  assert.equal(s.calibration.n, 2);
  assert.ok(Math.abs(s.calibration.mae - 0.75) < 1e-9);
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].trades, 2);
  assert.equal(s.groups[0].winRate, 100);
  assert.equal(s.groups[0].meanPct, 4);
  assert.equal(s.groups[0].medianPct, 4);
  assert.deepEqual(s.groups[0].exitMix, { tp: 2 });
  assert.equal(s.buckets.rangePct[0].bucket, "50-59");
  assert.equal(s.buckets.rangePct[0].trades, 2);
  assert.equal(s.buckets.flipPct[0].bucket, "60");
});

test("summarizeRows: paper rows and rows without pnl or predictions stay out of calibration", () => {
  const base = { profile: "degen", params: { rangePct: 35, flipPct: 60 }, flipped: true, holdMin: 30, exitReason: "stop" };
  const s = summarizeRows([
    { ...base, mode: "paper", pnlPct: -10, predicted: null },
    { ...base, mode: "live", pnlPct: 2, predicted: null },
    { ...base, mode: "live", pnlPct: null, predicted: { 0.25: 1, 0.5: 1, 1: 1, 2: 1, 4: 1 } },
  ]);
  assert.equal(s.calibration, null);
  const paper = s.groups.find((g) => g.mode === "paper");
  const live = s.groups.find((g) => g.mode === "live");
  assert.equal(paper.trades, 1);
  assert.equal(paper.winRate, 0);
  assert.equal(paper.flipRate, 100);
  assert.equal(live.trades, 1); // baris tanpa pnl tidak dihitung
  assert.deepEqual(summarizeRows([]), { groups: [], buckets: { rangePct: [], flipPct: [] }, calibration: null });
});
