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

const { trackPosition, markClosedNotDetected, recordClose } = await import("../src/state/positions.js");
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
const { __setSender } = await import("../src/notify/telegram.js");
const { addEntryInProgressPool, removeEntryInProgressPool } = await import("../src/entry/runtime.js");
const {
  syncTrades,
  runTradeExits,
  runFastTradeExitTick,
  settleTradesForPositions,
  legacyAdoptionCount,
  settleOpenTrades,
} = await import("../src/exit/trade-loop.js");

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

// Semua trade (terbuka + tertutup) langsung dari file state.
function listTrades() {
  if (!fs.existsSync(process.env.STATE_FILE)) return [];
  return Object.values(JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")).trades || {});
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
  const bootedAt = Date.now() - 1000;
  trackPosition("PosY", "PoolA", "AAA-SOL", "MintA", null, "spot");
  syncTrades([live("PosY", 1)], { wasTracked: new Set(["PosY"]), bootedAt });
  const t = findTradeByPosition("PosY");
  assert.equal(t.origin, "auto");
  assert.deepEqual(t.exit, EXIT);
  // Tidak dobel pada tick berikutnya.
  syncTrades([live("PosY", 1)], { wasTracked: new Set(["PosY"]), bootedAt });
  assert.equal(listOpenTrades().length, 1);
});

test("position tracked before this boot is adopted as auto with all exits off (legacy)", () => {
  reset();
  trackPosition("PosL", "PoolA", "AAA-SOL", "MintA", null, "spot");
  const bootedAt = Date.now() + 1000; // proses ini mulai setelah posisi pertama terlihat
  syncTrades([live("PosL", 1)], { wasTracked: new Set(["PosL"]), bootedAt });
  const t = findTradeByPosition("PosL");
  assert.equal(t.origin, "auto");
  assert.equal(t.exit.tp.on, false);
  assert.equal(t.exit.sl.on, false);
  assert.equal(t.exit.trail.on, false);
  assert.equal(t.exit.tp.pct, 15);
});

test("legacyAdoptionCount counts open tracked positions from before boot without a trade", () => {
  reset();
  trackPosition("PosL1", "PoolA", "AAA-SOL", "MintA", null, "spot");
  trackPosition("PosL2", "PoolA", "AAA-SOL", "MintA", null, "spot");
  trackPosition("PosL3", "PoolA", "AAA-SOL", "MintA", null, "spot");
  markClosedNotDetected("PosL3");
  newTrade(["PosT"]);
  const bootedAt = Date.now() + 1000;
  assert.equal(legacyAdoptionCount({ bootedAt }), 2);
  assert.equal(legacyAdoptionCount({ bootedAt: 0 }), 0);
});

test("does not adopt positions of a pool that is being opened", () => {
  reset();
  const pos = live("PosO", 1);
  addEntryInProgressPool(pos.pool);
  try {
    syncTrades([pos], { wasTracked: new Set() });
    assert.equal(findTradeByPosition("PosO"), null);
  } finally {
    removeEntryInProgressPool(pos.pool);
  }
  syncTrades([pos], { wasTracked: new Set() });
  assert.equal(findTradeByPosition("PosO").origin, "external");
});

test("closed-but-live position is never adopted again (3 ticks)", (t) => {
  reset();
  const logMock = t.mock.method(console, "log", () => {}); // log.warn mencetak ke console
  const sent = [];
  __setSender((text) => sent.push(text));
  t.after(() => __setSender(null));
  trackPosition("PosD", "PoolA", "AAA-SOL", "MintA", null, "spot");
  markClosedNotDetected("PosD");
  for (let i = 0; i < 3; i++) syncTrades([live("PosD", 1)], { wasTracked: new Set(["PosD"]) });
  assert.deepEqual(listTrades(), []);
  // Peringatan sekali per alamat, bukan tiap tick.
  const warns = logMock.mock.calls.filter((c) => String(c.arguments[0]).includes("closed di state"));
  assert.equal(warns.length, 1);
  // Alert Telegram juga sekali per alamat.
  assert.deepEqual(sent, ["Position PosD is still on-chain but marked closed — check it on Meteora."]);
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

test("partial trade: leg A closed, leg B at -40% hits SL 25 on the remaining leg", async () => {
  reset();
  const t = newTrade(["PosA", "PosB"]);
  recordClose("PosA", "manual", 5, { pnlUsd: 5 });
  const { deps, calls } = fakeDeps({ reread: new Map([["PosB", entry(-40)]]) });
  const ids = await runTradeExits([live("PosB", -40)], { deps });
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.closeTrade.length, 1);
  assert.equal(calls.closeTrade[0].trade.id, t.id);
  assert.equal(calls.closeTrade[0].opts.reason, "sl");
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

test("fast tick reads fresh PnL per pool and closes on tp", async () => {
  reset();
  const t = newTrade(["PosA"]);
  const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(16)]]) });
  // Snapshot loop utama masih PnL lama (0); PnL segar dari fetch yang memicu TP.
  const ids = await runFastTradeExitTick({ positions: [live("PosA", 0, { lowerBin: 1 })], deps });
  assert.equal(calls.fetch.length, 2); // bacaan tick + baca ulang konfirmasi
  assert.equal(calls.fetch[0].pool, "PoolA");
  assert.equal(calls.fetch[0].opts.force, true);
  assert.equal(calls.closeTrade.length, 1);
  assert.equal(calls.closeTrade[0].opts.reason, "tp");
  // Field on-chain dari snapshot ikut terbawa ke close.
  assert.equal(calls.closeTrade[0].opts.positionsByAddr.get("PosA").lowerBin, 1);
  assert.ok(ids.has(t.id));
});

test("fast tick skips trades with every exit off", async () => {
  reset();
  newTrade(["PosA"], {
    tp: { on: false, pct: 15 },
    sl: { on: false, pct: 25 },
    trail: { on: false, startPct: 5, distancePct: 3 },
  });
  const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(16)]]) });
  await runFastTradeExitTick({ positions: [live("PosA", 0)], deps });
  assert.equal(calls.fetch.length, 0);
});

test("fast tick ignores positions missing from the main loop snapshot", async () => {
  reset();
  newTrade(["PosA"]);
  const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(16)]]) });
  // Masih "open" di Meteora tapi sudah tidak terbaca on-chain -> jangan coba close.
  await runFastTradeExitTick({ positions: [], deps });
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.closeTrade.length, 0);
});

test("fast tick skips a locked trade", async () => {
  reset();
  const t = newTrade(["PosA"]);
  assert.ok(tryLockTrade(t.id, "close"));
  try {
    const { deps, calls } = fakeDeps({ reread: new Map([["PosA", entry(16)]]) });
    await runFastTradeExitTick({ positions: [live("PosA", 0)], deps });
    assert.equal(calls.fetch.length, 0);
    assert.equal(calls.closeTrade.length, 0);
  } finally {
    unlockTrade(t.id);
  }
});

test("unchanged progress does not rewrite state", async () => {
  reset();
  const t = newTrade(["PosA"]);
  updateTradeProgress(t.id, { peakPnlPct: 7, trailArmed: true });
  const { deps } = fakeDeps({ reread: null });
  const before = fs.readFileSync(process.env.STATE_FILE, "utf8");
  fs.writeFileSync(process.env.STATE_FILE, before.replace(/\n/g, "\r\n")); // penanda: tulis ulang menghapus CRLF
  await runTradeExits([live("PosA", 6)], { deps });
  assert.ok(fs.readFileSync(process.env.STATE_FILE, "utf8").includes("\r\n"));
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

test("settleOpenTrades settles a trade whose last leg was closed per position (no live positions left)", () => {
  reset();
  const t = newTrade(["PosA"]);
  // handleClose mencatat close per posisi; tidak ada posisi live tersisa.
  recordClose("PosA", "stop_loss", -30, { pnlUsd: -30, closeTx: "TxSL" });
  settleOpenTrades();
  const after = getTrade(t.id);
  assert.equal(after.closed, true);
  assert.equal(after.closeReason, "stop_loss");
  assert.equal(after.closePnlUsd, -30);
  assert.equal(after.closeTx, "TxSL");
});

test("settleTradesForPositions settles trades of missing addresses", () => {
  reset();
  const t = newTrade(["PosA"]);
  markClosedNotDetected("PosA");
  settleTradesForPositions(["PosA"]);
  assert.equal(getTrade(t.id).closed, true);
  assert.equal(getTrade(t.id).closeReason, "closed_outside");
});

test("locked trade is not settled by the exit loop (closeTrade settles it and sends the alert)", () => {
  reset();
  const t = newTrade(["PosA"]);
  assert.equal(tryLockTrade(t.id, "close"), true);
  try {
    // Telegram close sedang berjalan: leg sudah tertutup, closeTrade belum sempat settle.
    recordClose("PosA", "tp", 5, { pnlUsd: 5, closeTx: "TxTP" });
    settleOpenTrades();
    syncTrades([], { wasTracked: new Set() });
    settleTradesForPositions(["PosA"]);
    assert.equal(getTrade(t.id).closed, false);
  } finally {
    unlockTrade(t.id);
  }
  settleOpenTrades();
  assert.equal(getTrade(t.id).closed, true);
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
