import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-closetrade-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { trackPosition, recordClose, updateClosePnl, getTrackedPosition } = await import("../src/state/positions.js");
const { createTrade, getTrade, setTradeDepositUsd, tryLockTrade, tradeLock, unlockTrade } =
  await import("../src/state/trades.js");
const { closeTrade } = await import("../src/lp/close-trade.js");
const { claimTrade } = await import("../src/lp/claim.js");
const { listKeepMints, addKeepMint } = await import("../src/state/keep-mints.js");
const { handleClose } = await import("../src/exit/close.js");

const EXIT = {
  tp: { on: true, pct: 15 },
  sl: { on: true, pct: 25 },
  trail: { on: true, startPct: 5, distancePct: 3 },
};

function reset() {
  fs.rmSync(process.env.STATE_FILE, { force: true });
  fs.rmSync(process.env.DECISION_LOG_FILE, { force: true });
}

function newTrade(positions, origin = "manual") {
  for (const p of positions) trackPosition(p, "PoolA", "AAA-SOL", "MintA", null, "spot");
  const t = createTrade({
    pool: "PoolA",
    pair: "AAA-SOL",
    baseMint: "MintA",
    positions,
    origin,
    exit: structuredClone(EXIT),
  });
  setTradeDepositUsd(t.id, 100);
  return getTrade(t.id);
}

function fakeDeps(overrides = {}) {
  const calls = { handleClose: [], swapToSol: [], notify: [], claim: [] };
  const deps = {
    handleClose: async (pos, reason, opts) => {
      calls.handleClose.push({ pos, reason, opts });
      recordClose(pos.position, reason, 5, { pnlUsd: 5, closeTx: `tx-${pos.position}` });
      return { success: true, swapInfo: null, closeTx: `tx-${pos.position}`, pnlUsd: 5, pnlPct: 5 };
    },
    getTokenBalance: async () => 100,
    swapToSol: async (mint, amount) => {
      calls.swapToSol.push([mint, amount]);
      return { success: true };
    },
    notifyTradeClosed: (trade, extra) => calls.notify.push({ trade, extra }),
    claimPositionFees: async (addr) => {
      calls.claim.push(addr);
      return { success: true, txs: ["claim-tx"] };
    },
    ...overrides,
  };
  return { deps, calls };
}

test("close settles and alerts once", async () => {
  reset();
  const t = newTrade(["A", "B"]);
  const { deps, calls } = fakeDeps();
  const res = await closeTrade(t, { reason: "manual", deps });
  assert.equal(res.success, true);
  assert.deepEqual(res.failed, []);
  assert.equal(calls.handleClose.length, 2);
  assert.deepEqual(calls.handleClose[0].opts, { skipAutoSwap: true, silent: true });
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0].trade.id, t.id);
  const stored = getTrade(t.id);
  assert.equal(stored.closed, true);
  assert.equal(stored.closeReason, "manual");
  assert.equal(stored.closePnlUsd, 10);
  assert.equal(tradeLock(t.id), null);
});

test("close uses the live position object when provided", async () => {
  reset();
  const t = newTrade(["A"]);
  const live = { position: "A", pool: "PoolA", pair: "AAA-SOL", pnlUsd: 1.5 };
  const { deps, calls } = fakeDeps();
  await closeTrade(t, { reason: "tp", positionsByAddr: new Map([["A", live]]), deps });
  assert.equal(calls.handleClose[0].pos, live);
});

test("close falls back to a minimal position object", async () => {
  reset();
  const t = newTrade(["A"]);
  const { deps, calls } = fakeDeps();
  await closeTrade(t, { reason: "tp", deps });
  assert.deepEqual(calls.handleClose[0].pos, {
    position: "A",
    pool: "PoolA",
    pair: "AAA-SOL",
    baseMint: "MintA",
  });
});

test("swap happens once for all legs", async () => {
  reset();
  const t = newTrade(["A", "B"]);
  const { deps, calls } = fakeDeps();
  const res = await closeTrade(t, { reason: "manual", deps });
  assert.deepEqual(calls.swapToSol, [["MintA", 100]]);
  assert.equal(res.swapInfo.success, true);
  assert.equal(calls.notify[0].extra.swapInfo.success, true);
});

test("close only does not swap", async () => {
  reset();
  const t = newTrade(["A"]);
  const { deps, calls } = fakeDeps();
  const res = await closeTrade(t, { reason: "manual", swap: false, deps });
  assert.equal(res.success, true);
  assert.equal(calls.swapToSol.length, 0);
  assert.equal(res.swapInfo, null);
});

test("failed swap is reported but the trade still settles", async () => {
  reset();
  const t = newTrade(["A"]);
  const { deps, calls } = fakeDeps({ swapToSol: async () => ({ success: false, error: "no route\nmore" }) });
  const res = await closeTrade(t, { reason: "manual", deps });
  assert.equal(res.success, true);
  assert.equal(res.swapInfo.success, false);
  assert.equal(res.swapInfo.error, "no route");
  assert.equal(calls.notify.length, 1);
  assert.equal(getTrade(t.id).closed, true);
});

test("busy when locked", async () => {
  reset();
  const t = newTrade(["A"]);
  const { deps, calls } = fakeDeps();
  assert.equal(tryLockTrade(t.id, "claim"), true);
  const res = await closeTrade(t, { reason: "manual", deps });
  assert.equal(res.success, false);
  assert.equal(res.busy, true);
  assert.equal(calls.handleClose.length, 0);
  // kunci milik pihak lain tidak boleh dilepas oleh closeTrade
  assert.equal(tradeLock(t.id), "claim");
  unlockTrade(t.id);
});

test("leg failure keeps trade open and releases the lock", async () => {
  reset();
  const t = newTrade(["A", "B"]);
  const { deps, calls } = fakeDeps({
    handleClose: async (pos, reason) => {
      if (pos.position === "B") return { success: false, error: "boom" };
      recordClose(pos.position, reason, 5, { pnlUsd: 5 });
      return { success: true };
    },
  });
  const res = await closeTrade(t, { reason: "manual", deps });
  assert.equal(res.success, false);
  assert.deepEqual(res.failed, ["B"]);
  assert.equal(calls.notify.length, 0);
  // token dari leg A yang sudah tertutup tetap di-swap satu kali
  assert.deepEqual(calls.swapToSol, [["MintA", 100]]);
  assert.equal(getTrade(t.id).closed, false);
  assert.equal(tradeLock(t.id), null);
});

test("every leg is attempted even after a failure", async () => {
  reset();
  const t = newTrade(["A", "B"]);
  const seen = [];
  const { deps, calls } = fakeDeps({
    handleClose: async (pos) => {
      seen.push(pos.position);
      return { success: false, error: "boom" };
    },
  });
  const res = await closeTrade(t, { reason: "manual", deps });
  assert.deepEqual(seen, ["A", "B"]);
  assert.deepEqual(res.failed, ["A", "B"]);
  assert.equal(calls.swapToSol.length, 0);
});

test("a thrown leg error counts as a failure and still releases the lock", async () => {
  reset();
  const t = newTrade(["A"]);
  const { deps } = fakeDeps({
    handleClose: async () => {
      throw new Error("rpc down");
    },
  });
  const res = await closeTrade(t, { reason: "manual", deps });
  assert.equal(res.success, false);
  assert.deepEqual(res.failed, ["A"]);
  assert.equal(tradeLock(t.id), null);
});

test("legs already closed are skipped on retry", async () => {
  reset();
  const t = newTrade(["A", "B"]);
  recordClose("A", "manual", 5, { pnlUsd: 5, closeTx: "txA" });
  const { deps, calls } = fakeDeps();
  const res = await closeTrade(getTrade(t.id), { reason: "manual", deps });
  assert.equal(res.success, true);
  assert.deepEqual(
    calls.handleClose.map((c) => c.pos.position),
    ["B"]
  );
  assert.equal(getTrade(t.id).closed, true);
});

test("already closed trade is a no-op", async () => {
  reset();
  const t = newTrade(["A"]);
  const { deps, calls } = fakeDeps();
  await closeTrade(t, { reason: "manual", deps });
  const again = await closeTrade(getTrade(t.id), { reason: "manual", deps });
  assert.equal(again.success, true);
  assert.equal(calls.handleClose.length, 1);
  assert.equal(calls.notify.length, 1);
});

test("recordClose does not overwrite an already-closed leg", () => {
  reset();
  newTrade(["A"]);
  recordClose("A", "tp", 5, { pnlUsd: 5, closeTx: "tx1" });
  const first = getTrackedPosition("A");
  recordClose("A", "manual", null, {});
  const after = getTrackedPosition("A");
  assert.equal(after.closePnlUsd, 5);
  assert.equal(after.closeTx, "tx1");
  assert.equal(after.closeReason, "tp");
  assert.equal(after.closedAt, first.closedAt);
  const log = JSON.parse(fs.readFileSync(process.env.DECISION_LOG_FILE, "utf8"));
  assert.equal(log.filter((e) => e.position === "A").length, 1);
});

test("claim swaps once when asked", async () => {
  reset();
  const t = newTrade(["A", "B"]);
  const { deps, calls } = fakeDeps();
  const res = await claimTrade(t, { swap: true, deps });
  assert.equal(res.success, true);
  assert.equal(res.claimed, 2);
  assert.deepEqual(res.failed, []);
  assert.deepEqual(calls.claim, ["A", "B"]);
  assert.deepEqual(calls.swapToSol, [["MintA", 100]]);
  assert.equal(res.swapInfo.success, true);
  assert.equal(tradeLock(t.id), null);
  assert.equal(getTrade(t.id).closed, false);
});

test("claim does not swap by default", async () => {
  reset();
  const t = newTrade(["A"]);
  const { deps, calls } = fakeDeps();
  const res = await claimTrade(t, { deps });
  assert.equal(res.success, true);
  assert.equal(calls.swapToSol.length, 0);
});

test("claim lists failed legs and is busy while locked", async () => {
  reset();
  const t = newTrade(["A", "B"]);
  const { deps, calls } = fakeDeps({
    claimPositionFees: async (addr) => (addr === "A" ? { success: false, error: "x" } : { success: true, txs: [] }),
  });
  const res = await claimTrade(t, { swap: true, deps });
  assert.equal(res.success, false);
  assert.deepEqual(res.failed, ["A"]);
  assert.equal(res.claimed, 1);
  assert.equal(tradeLock(t.id), null);

  tryLockTrade(t.id, "close");
  const busy = await claimTrade(t, { deps });
  assert.equal(busy.success, false);
  assert.equal(busy.busy, true);
  assert.equal(tradeLock(t.id), "close");
  unlockTrade(t.id);
  // leg B berhasil diklaim -> swap satu kali walau leg A gagal
  assert.equal(calls.swapToSol.length, 1);
});

test("close only keeps the mint out of the sweep; a later close with swap releases it", async () => {
  reset();
  const { deps } = fakeDeps();
  await closeTrade(newTrade(["A"]), { reason: "manual", swap: false, deps });
  assert.deepEqual(listKeepMints(), ["MintA"]);
  await closeTrade(newTrade(["B"]), { reason: "manual", swap: true, deps });
  assert.deepEqual(listKeepMints(), []);
});

test("plain claim keeps the mint; claim with swap releases it", async () => {
  reset();
  const t = newTrade(["A"]);
  const { deps } = fakeDeps();
  await claimTrade(t, { deps });
  assert.deepEqual(listKeepMints(), ["MintA"]);
  await claimTrade(t, { deps });
  assert.deepEqual(listKeepMints(), ["MintA"]);
  await claimTrade(t, { swap: true, deps });
  assert.deepEqual(listKeepMints(), []);
});

test("legacy handleClose clears a kept mint once it auto-swaps it; a failed swap keeps it", async () => {
  for (const swapOk of [false, true]) {
    reset();
    trackPosition("PosK", "PoolA", "AAA-SOL", "MintA", null, "spot");
    addKeepMint("MintA");
    const deps = {
      closePosition: async () => ({ success: true, dryRun: true, baseMint: "MintA" }),
      getTokenBalance: async () => 10,
      swapToSol: async () => (swapOk ? { success: true } : { success: false, error: "no route" }),
    };
    const pos = { position: "PosK", pool: "PoolA", pair: "AAA-SOL", baseMint: "MintA", pnlPct: 1 };
    const res = await handleClose(pos, "stop_loss", { silent: true, deps });
    assert.equal(res.success, true);
    assert.deepEqual(listKeepMints(), swapOk ? [] : ["MintA"]);
  }
});

test("closeTrade alerts with live PnL, then edits the alert once final PnL arrives", async () => {
  reset();
  const t = newTrade(["A", "B"]);
  let release;
  const gate = new Promise((r) => (release = r));
  const { deps, calls } = fakeDeps({
    handleClose: async (pos, reason) => {
      recordClose(pos.position, reason, 5, { pnlUsd: 5, closeTx: `tx-${pos.position}` });
      const finalPnl = gate.then(
        () => updateClosePnl(pos.position, { pnlPct: 8, pnlUsd: 8 }) && { pnlPct: 8, pnlUsd: 8 }
      );
      return { success: true, swapInfo: null, closeTx: `tx-${pos.position}`, pnlUsd: 5, pnlPct: 5, finalPnl };
    },
    notifyTradeClosed: (trade, extra) => {
      calls.notify.push({ trade: structuredClone(trade), extra });
      return 99;
    },
  });
  const res = await closeTrade(t, { reason: "manual", swap: false, deps });
  assert.equal(res.success, true);
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0].trade.closePnlUsd, 10);
  assert.equal(calls.notify[0].extra.editMessageId, undefined);

  release();
  await res.finalPnl;
  assert.equal(getTrade(t.id).closePnlUsd, 16);
  assert.equal(calls.notify.length, 2);
  assert.equal(calls.notify[1].extra.editMessageId, 99);
  assert.equal(calls.notify[1].trade.closePnlUsd, 16);
});

test("handleClose records live PnL first, then final Meteora PnL and edits the alert", async () => {
  reset();
  trackPosition("PosF", "PoolA", "AAA-SOL", "MintA", null, "spot");
  const sent = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const deps = {
    closePosition: async () => ({ success: true, txs: ["sig-close"], baseMint: null }),
    waitClosedPositionEntry: async () => {
      await gate;
      return { pnlPctChange: "7.5", pnlSolPctChange: "7.5", pnlUsd: "3.2" };
    },
    notifyClose: (...args) => {
      sent.push(args);
      return 55;
    },
  };
  const pos = { position: "PosF", pool: "PoolA", pair: "AAA-SOL", baseMint: "MintA", pnlPct: 1, pnlUsd: 0.4 };
  const res = await handleClose(pos, "stop_loss", { deps });

  assert.equal(res.success, true);
  assert.equal(res.pnlPct, 1);
  assert.equal(getTrackedPosition("PosF").closePnlPct, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][2], 1);

  release();
  assert.deepEqual(await res.finalPnl, { pnlPct: 7.5, pnlUsd: 3.2 });
  assert.equal(getTrackedPosition("PosF").closePnlPct, 7.5);
  assert.equal(getTrackedPosition("PosF").closePnlUsd, 3.2);
  assert.equal(sent.length, 2);
  assert.equal(sent[1][2], 7.5);
  assert.equal(sent[1][6].editMessageId, 55);
});

test("handleClose keeps live PnL and does not edit when final PnL never arrives", async () => {
  reset();
  trackPosition("PosG", "PoolA", "AAA-SOL", "MintA", null, "spot");
  const sent = [];
  const deps = {
    closePosition: async () => ({ success: true, txs: ["sig-close"], baseMint: null }),
    waitClosedPositionEntry: async () => null,
    notifyClose: (...args) => sent.push(args),
  };
  const pos = { position: "PosG", pool: "PoolA", pair: "AAA-SOL", baseMint: "MintA", pnlPct: 2, pnlUsd: 1 };
  const res = await handleClose(pos, "tp", { deps });
  assert.equal(await res.finalPnl, null);
  assert.equal(getTrackedPosition("PosG").closePnlPct, 2);
  assert.equal(sent.length, 1);
});
