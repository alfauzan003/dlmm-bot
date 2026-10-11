import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state/settings ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tradeloop-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { trackPosition, markClosedNotDetected } = await import("../src/state/positions.js");
const {
  createTrade,
  getTrade,
  listOpenTrades,
  findTradeByPosition,
  setTradeDepositUsd,
  updateTradeProgress,
  tryLockTrade,
  unlockTrade,
} = await import("../src/state/trades.js");
const { setToggle } = await import("../src/state/settings.js");
const { syncTrades, runTradeExits, tradeAwareClose, settleTradesForPositions } =
  await import("../src/exit/trade-loop.js");

const EXIT = {
  tp: { on: true, pct: 15 },
  sl: { on: true, pct: 25 },
  trail: { on: true, startPct: 5, distancePct: 3 },
};

function reset() {
  fs.rmSync(process.env.STATE_FILE, { force: true });
  fs.rmSync(process.env.DECISION_LOG_FILE, { force: true });
  fs.rmSync(process.env.SETTINGS_FILE, { force: true });
}

function live(addr, pnlUsd, extra = {}) {
  return {
    position: addr,
    pool: "PoolA",
    pair: "AAA-SOL",
    baseMint: "MintA",
    pnlPct: pnlUsd,
    pnlUsd,
    depositUsd: 100,
    pnlKnown: true,
    ...extra,
  };
}

function newTrade(positions, exit = EXIT) {
  for (const p of positions) trackPosition(p, "PoolA", "AAA-SOL", "MintA", null, "spot");
  const t = createTrade({
    pool: "PoolA",
    pair: "AAA-SOL",
    baseMint: "MintA",
    positions,
    origin: "manual",
    exit: structuredClone(exit),
  });
  setTradeDepositUsd(t.id, 100 * positions.length);
  return getTrade(t.id);
}

// Entri mentah Meteora (bentuk yang dibaca usdPnlFromEntry).
function entry(pnlUsd) {
  return { pnlUsd, allTimeDeposits: { total: { usd: 100 } } };
}

function fakeDeps({ reread, closeResult = { success: true, failed: [], swapInfo: null } }) {
  const calls = { closeTrade: [], fetch: [] };
  const deps = {
    fetchPoolPnl: async (pool, opts) => {
      calls.fetch.push({ pool, opts });
      return typeof reread === "function" ? reread() : reread;
    },
    closeTrade: async (trade, opts) => {
      calls.closeTrade.push({ trade, opts });
      return closeResult;
    },
  };
  return { deps, calls };
}

test("adopts external position with exits off", () => {
  reset();
  syncTrades([live("PosX", 1)], { wasTracked: new Set() });
  const t = findTradeByPosition("PosX");
  assert.ok(t);
  assert.equal(t.origin, "external");
  assert.deepEqual(t.positions, ["PosX"]);
  assert.equal(t.exit.tp.on, false);
  assert.equal(t.exit.sl.on, false);
  assert.equal(t.exit.trail.on, false);
  assert.equal(t.depositUsd, 100);
});

test("adopts bot-tracked position as auto with preset", () => {
  reset();
  syncTrades([live("PosY", 1)], { wasTracked: new Set(["PosY"]) });
  const t = findTradeByPosition("PosY");
  assert.equal(t.origin, "auto");
  assert.deepEqual(t.exit, EXIT);
  // Tidak dobel pada tick berikutnya.
  syncTrades([live("PosY", 1)], { wasTracked: new Set(["PosY"]) });
  assert.equal(listOpenTrades().length, 1);
});

test("depositUsd stays null while a leg is unknown", () => {
  reset();
  syncTrades([live("PosZ", undefined, { pnlKnown: false, depositUsd: NaN })], { wasTracked: new Set() });
  assert.equal(findTradeByPosition("PosZ").depositUsd, null);
});

test("tp closes after confirming re-read", async () => {
  reset();
  const t = newTrade(["PosA"]);
  const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(16)]]) });
  const ids = await runTradeExits([live("PosA", 16)], { deps });
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].pool, "PoolA");
  assert.equal(calls.fetch[0].opts.force, true);
  assert.equal(calls.fetch[0].opts.strict, true);
  assert.equal(calls.closeTrade.length, 1);
  assert.equal(calls.closeTrade[0].trade.id, t.id);
  assert.equal(calls.closeTrade[0].opts.reason, "tp");
  assert.equal(calls.closeTrade[0].opts.swap, true);
  assert.equal(calls.closeTrade[0].opts.positionsByAddr.get("PosA").pnlUsd, 16);
  assert.ok(ids.has(t.id));
  assert.equal(getTrade(t.id).peakPnlPct, 16);
});

test("glitch is not acted on", async () => {
  reset();
  const t = newTrade(["PosA"]);
  const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(3)]]) });
  const ids = await runTradeExits([live("PosA", 16)], { deps });
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.closeTrade.length, 0);
  assert.ok(!ids.has(t.id));
  // Peak dari bacaan yang tidak terkonfirmasi tidak disimpan (cegah trail palsu).
  assert.equal(getTrade(t.id).peakPnlPct, null);
  assert.equal(getTrade(t.id).trailArmed, false);
});

test("progress persists from the confirmed re-read, not the first read", async () => {
  reset();
  const t = newTrade(["PosA"]);
  updateTradeProgress(t.id, { peakPnlPct: 10, trailArmed: false });
  const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(16)]]), closeResult: { success: false } });
  await runTradeExits([live("PosA", 40)], { deps });
  assert.equal(calls.closeTrade.length, 1);
  assert.equal(calls.closeTrade[0].opts.reason, "tp");
  const after = getTrade(t.id);
  assert.equal(after.peakPnlPct, 16);
  assert.equal(after.trailArmed, true);
});

test("failed or unknown re-read is not acted on", async () => {
  for (const reread of [null, new Map(), new Map([["PosA", { pnlUsd: "", allTimeDeposits: {} }]])]) {
    reset();
    newTrade(["PosA"]);
    const { deps, calls } = fakeDeps({ reread });
    await runTradeExits([live("PosA", 16)], { deps });
    assert.equal(calls.closeTrade.length, 0);
  }
});

test("unknown PnL does nothing", async () => {
  reset();
  const t = newTrade(["PosA"]);
  const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(16)]]) });
  await runTradeExits([live("PosA", 16, { pnlKnown: undefined })], { deps });
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.closeTrade.length, 0);
  assert.equal(getTrade(t.id).peakPnlPct, null);
});

test("multi-leg trade needs every leg live and known", async () => {
  reset();
  newTrade(["PosA", "PosB"]);
  const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(40)]]) });
  // Leg B tidak terbaca -> PnL trade tidak diketahui.
  await runTradeExits([live("PosA", 40)], { deps });
  assert.equal(calls.closeTrade.length, 0);
});

test("re-read missing a leg of a multi-leg trade does not close", async () => {
  reset();
  newTrade(["PosA", "PosB"]);
  const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(40)]]) });
  await runTradeExits([live("PosA", 40), live("PosB", 40)], { deps });
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.closeTrade.length, 0);
});

test("sl on a multi-leg trade closes the whole trade", async () => {
  reset();
  const t = newTrade(["PosA", "PosB"]);
  const reread = new Map([
    ["PosA", entry(-30)],
    ["PosB", entry(-25)],
  ]);
  const { deps, calls } = fakeDeps({ reread });
  const ids = await runTradeExits([live("PosA", -30), live("PosB", -30)], { deps });
  assert.equal(calls.closeTrade.length, 1);
  assert.equal(calls.closeTrade[0].opts.reason, "sl");
  assert.equal(calls.closeTrade[0].opts.positionsByAddr.size, 2);
  assert.ok(ids.has(t.id));
});

test("peak and trail arming are persisted without a close", async () => {
  reset();
  const t = newTrade(["PosA"]);
  const { deps, calls } = fakeDeps({ reread: null });
  await runTradeExits([live("PosA", 7)], { deps });
  assert.equal(calls.fetch.length, 0);
  const after = getTrade(t.id);
  assert.ok(Math.abs(after.peakPnlPct - 7) < 1e-9);
  assert.equal(after.trailArmed, true);
});

test("trail confirmed against the stored peak closes", async () => {
  reset();
  const t = newTrade(["PosA"]);
  updateTradeProgress(t.id, { peakPnlPct: 10, trailArmed: true });
  const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(6)]]) });
  await runTradeExits([live("PosA", 6)], { deps });
  assert.equal(calls.closeTrade.length, 1);
  assert.equal(calls.closeTrade[0].opts.reason, "trail");
});

test("one leg closed outside", () => {
  reset();
  const t = newTrade(["PosA", "PosB"]);
  markClosedNotDetected("PosA");
  syncTrades([live("PosB", 1)], { wasTracked: new Set(["PosB"]) });
  assert.equal(getTrade(t.id).closed, false);
  markClosedNotDetected("PosB");
  syncTrades([], { wasTracked: new Set() });
  const after = getTrade(t.id);
  assert.equal(after.closed, true);
  assert.equal(after.closeReason, "closed_outside");
});

test("settleTradesForPositions settles trades of missing addresses", () => {
  reset();
  const t = newTrade(["PosA"]);
  markClosedNotDetected("PosA");
  settleTradesForPositions(["PosA"]);
  assert.equal(getTrade(t.id).closed, true);
  assert.equal(getTrade(t.id).closeReason, "closed_outside");
});

test("locked trade skipped", async () => {
  reset();
  const t = newTrade(["PosA"]);
  assert.equal(tryLockTrade(t.id, "close"), true);
  try {
    const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(16)]]) });
    const ids = await runTradeExits([live("PosA", 16)], { deps });
    assert.equal(calls.fetch.length, 0);
    assert.equal(calls.closeTrade.length, 0);
    assert.equal(getTrade(t.id).peakPnlPct, null);
    assert.ok(ids.has(t.id));
  } finally {
    unlockTrade(t.id);
  }
});

test("tradeAwareClose routes multi-leg to closeTrade and one-leg to handleClose", async () => {
  reset();
  setToggle("deterministicExit", true);
  const multi = newTrade(["PosA", "PosB"]);
  const single = newTrade(["PosC"]);
  const calls = { closeTrade: [], handleClose: [] };
  const deps = {
    closeTrade: async (trade, opts) => {
      calls.closeTrade.push({ trade, opts });
      return { success: true };
    },
    handleClose: async (pos, reason, opts) => {
      calls.handleClose.push({ pos, reason, opts });
      return { success: true };
    },
  };
  const positionsByAddr = new Map([["PosA", live("PosA", 9)]]);
  await tradeAwareClose(live("PosA", 9), "trailing_tp", undefined, { positionsByAddr, deps });
  assert.equal(calls.closeTrade.length, 1);
  assert.equal(calls.closeTrade[0].trade.id, multi.id);
  assert.equal(calls.closeTrade[0].opts.reason, "trailing_tp");
  assert.equal(calls.closeTrade[0].opts.swap, true);
  assert.equal(calls.closeTrade[0].opts.positionsByAddr, positionsByAddr);

  await tradeAwareClose(live("PosC", 9), "trailing_tp", { skipDeactivate: true }, { deps });
  assert.equal(calls.handleClose.length, 1);
  assert.equal(calls.handleClose[0].reason, "trailing_tp");
  assert.deepEqual(calls.handleClose[0].opts, { skipDeactivate: true });

  // Trade terkunci (mis. close dari Telegram) -> tidak ada close kedua.
  tryLockTrade(single.id, "close");
  try {
    const res = await tradeAwareClose(live("PosC", 9), "trailing_tp", undefined, { deps });
    assert.equal(res.success, false);
    assert.equal(calls.handleClose.length, 1);
  } finally {
    unlockTrade(single.id);
  }
});

test("tradeAwareClose does nothing once deterministic exit is off", async () => {
  reset();
  newTrade(["PosC"]);
  setToggle("deterministicExit", false);
  let closes = 0;
  const deps = {
    closeTrade: async () => closes++,
    handleClose: async () => closes++,
  };
  const res = await tradeAwareClose(live("PosC", 9), "trailing_tp", undefined, { deps });
  assert.equal(res.success, false);
  assert.equal(closes, 0);
});
