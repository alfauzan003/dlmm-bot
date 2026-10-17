import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state/settings ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-panda-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { trackPosition } = await import("../src/state/positions.js");
const { createTrade, getTrade, tryLockTrade, unlockTrade, updateTradePanda, setTradePanda } =
  await import("../src/state/trades.js");
const { readState, writeState } = await import("../src/state/store.js");
const { runEvilPanda, kickEvilPanda, __resetPandaThrottle } = await import("../src/exit/evil-panda.js");

const BAR = 900;
const NOW = (1_000_000 * BAR + 30) * 1000; // 30 detik setelah bar 1_000_000 mulai
const LATEST = (1_000_000 - 1) * BAR; // bar tutup terakhir

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function reset() {
  fs.rmSync(process.env.STATE_FILE, { force: true });
  __resetPandaThrottle();
}

const candle = (time, close) => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 1 });

// 40 bar naik (bullish), 1 bar jatuh 30 (break), 6 bar datar, 1 bar naik 5 (RSI(2) > 90, tetap di bawah
// Supertrend), lalu bar yang masih terbentuk. Bar terakhir yang tutup = LATEST.
function spikeCandles({ lastClosed = LATEST } = {}) {
  const closes = [...Array.from({ length: 40 }, (_, i) => 100 + i), 109, 109, 109, 109, 109, 109, 109, 114];
  const first = lastClosed - (closes.length - 1) * BAR;
  const list = closes.map((c, i) => candle(first + i * BAR, c));
  list.push(candle(lastClosed + BAR, 114));
  return list;
}

function newTrade({ positions = ["PosA"], mint = "MintA", panda = true } = {}) {
  for (const p of positions) trackPosition(p, "PoolA", "AAA-SOL", mint, null, "spot");
  const t = createTrade({
    pool: "PoolA",
    pair: "AAA-SOL",
    baseMint: mint,
    positions,
    origin: "manual",
    exit: { tp: { on: false, pct: 15 }, sl: { on: false, pct: 25 }, trail: { on: false }, panda: { on: panda } },
  });
  // Trade dibuka sebelum candle fixture supaya semua bar ikut dihitung.
  const state = readState();
  state.trades[String(t.id)].openedAt = 0;
  writeState(state);
  return getTrade(t.id);
}

const live = (addr, mint = "MintA") => ({ position: addr, pool: "PoolA", pair: "AAA-SOL", baseMint: mint });

function fakeDeps({ candles = spikeCandles(), closeImpl } = {}) {
  const calls = { fetchCandles: [], closeTrade: [] };
  const deps = {
    fetchCandles: async (mint, pool, opts) => {
      calls.fetchCandles.push({ mint, pool, opts });
      return candles;
    },
    fetchPoolPnl: async () => new Map([["PosA", { pnlUsd: 5, allTimeDeposits: { total: { usd: 100 } } }]]),
    closeTrade: async (trade, opts) => {
      calls.closeTrade.push({ trade, opts });
      if (closeImpl) return closeImpl(calls.closeTrade.length);
      return { success: true, failed: [] };
    },
  };
  return { deps, calls };
}

test("fires on the RSI spike and closes with evil_panda_rsi", async () => {
  reset();
  const t = newTrade();
  const { deps, calls } = fakeDeps();
  const handled = await runEvilPanda([live("PosA")], { deps, now: NOW });
  assert.deepEqual(calls.fetchCandles[0].opts, { resolution: "15m", limit: 90, allowStale: false });
  assert.equal(calls.closeTrade.length, 1);
  assert.equal(calls.closeTrade[0].opts.reason, "evil_panda_rsi");
  assert.equal(calls.closeTrade[0].opts.swap, true);
  assert.ok(calls.closeTrade[0].opts.positionsByAddr.get("PosA").pnlKnown);
  assert.ok(handled.has(t.id));
  const p = getTrade(t.id).panda;
  assert.equal(p.armed, true);
  assert.equal(p.lastBar, LATEST - BAR);
});

test("a failed close is retried on the next tick", async () => {
  reset();
  newTrade();
  const { deps, calls } = fakeDeps({
    closeImpl: (n) => {
      if (n === 1) throw new Error("rpc down");
      return { success: true, failed: [] };
    },
  });
  await runEvilPanda([live("PosA")], { deps, now: NOW });
  await runEvilPanda([live("PosA")], { deps, now: NOW });
  assert.equal(calls.closeTrade.length, 2);
});

test("no fetch when no new bar has closed since lastBar", async () => {
  reset();
  const t = newTrade();
  updateTradePanda(t.id, { seenAbove: true, armed: false, lastBar: LATEST });
  const { deps, calls } = fakeDeps();
  await runEvilPanda([live("PosA")], { deps, now: NOW });
  assert.equal(calls.fetchCandles.length, 0);
});

test("late data (latest closed bar missing) waits without saving progress", async () => {
  reset();
  const t = newTrade();
  const { deps, calls } = fakeDeps({ candles: spikeCandles({ lastClosed: LATEST - BAR }).slice(0, -1) });
  await runEvilPanda([live("PosA")], { deps, now: NOW });
  assert.equal(calls.closeTrade.length, 0);
  assert.equal(getTrade(t.id).panda, undefined);
});

test("a candle fetch failure does nothing", async () => {
  reset();
  const t = newTrade();
  const { deps, calls } = fakeDeps({ candles: null });
  await runEvilPanda([live("PosA")], { deps, now: NOW });
  assert.equal(calls.closeTrade.length, 0);
  assert.equal(getTrade(t.id).panda, undefined);
});

test("a locked trade is skipped", async () => {
  reset();
  const t = newTrade();
  tryLockTrade(t.id, "close");
  try {
    const { deps, calls } = fakeDeps();
    await runEvilPanda([live("PosA")], { deps, now: NOW });
    assert.equal(calls.fetchCandles.length, 0);
    assert.equal(calls.closeTrade.length, 0);
  } finally {
    unlockTrade(t.id);
  }
});

test("trades with Panda off or without a live leg are ignored", async () => {
  reset();
  newTrade({ positions: ["PosA"], panda: false });
  newTrade({ positions: ["PosB"] });
  const { deps, calls } = fakeDeps();
  await runEvilPanda([live("PosA")], { deps, now: NOW });
  assert.equal(calls.fetchCandles.length, 0);
});

test("one candle fetch per mint per tick", async () => {
  reset();
  newTrade({ positions: ["PosA"] });
  newTrade({ positions: ["PosC"] });
  const { deps, calls } = fakeDeps();
  await runEvilPanda([live("PosA"), live("PosC")], { deps, now: NOW });
  assert.equal(calls.fetchCandles.length, 1);
});

test("Panda turned off while candles load does not close", async () => {
  reset();
  const t = newTrade();
  const { deps, calls } = fakeDeps();
  const fetch = deps.fetchCandles;
  deps.fetchCandles = async (...args) => {
    setTradePanda(t.id, false);
    return fetch(...args);
  };
  await runEvilPanda([live("PosA")], { deps, now: NOW });
  assert.equal(calls.closeTrade.length, 0);
  assert.equal(getTrade(t.id).panda, undefined);
});

test("Panda reset (off then on) while candles load keeps the reset progress", async () => {
  reset();
  const t = newTrade();
  updateTradePanda(t.id, { seenAbove: true, armed: true, lastBar: LATEST - 3 * BAR });
  const { deps, calls } = fakeDeps();
  const fetch = deps.fetchCandles;
  deps.fetchCandles = async (...args) => {
    setTradePanda(t.id, false);
    setTradePanda(t.id, true);
    return fetch(...args);
  };
  await runEvilPanda([live("PosA")], { deps, now: NOW });
  assert.equal(calls.closeTrade.length, 0);
  assert.equal(getTrade(t.id).panda, undefined);
});

test("updateTradePanda does nothing while Panda is off", () => {
  reset();
  const t = newTrade({ panda: false });
  assert.equal(updateTradePanda(t.id, { seenAbove: true, armed: true, lastBar: 900 }), null);
  assert.equal(getTrade(t.id).panda, undefined);
});

test("incomplete candles are retried at most every 60 s and 3 times per bar", async () => {
  reset();
  newTrade();
  const late = spikeCandles({ lastClosed: LATEST - BAR }).slice(0, -1);
  const { deps, calls } = fakeDeps({ candles: late });
  for (const dt of [0, 10, 59, 61, 125, 190, 260]) await runEvilPanda([live("PosA")], { deps, now: NOW + dt * 1000 });
  assert.equal(calls.fetchCandles.length, 3);
});

test("kickEvilPanda runs in the background and never overlaps", async () => {
  reset();
  newTrade();
  let release;
  const gate = new Promise((r) => (release = r));
  const { deps, calls } = fakeDeps();
  const fetch = deps.fetchCandles;
  deps.fetchCandles = async (...args) => {
    await gate;
    return fetch(...args);
  };
  const first = kickEvilPanda([live("PosA")], { deps, now: NOW });
  assert.ok(first);
  assert.equal(kickEvilPanda([live("PosA")], { deps, now: NOW }), null);
  release();
  await first;
  assert.equal(calls.fetchCandles.length, 1);
  assert.ok(kickEvilPanda([live("PosA")], { deps, now: NOW }));
});
