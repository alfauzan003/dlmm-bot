import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-trades-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { trackPosition, recordClose, markClosedNotDetected, getTrackedPosition } =
  await import("../src/state/positions.js");
const {
  createTrade,
  getTrade,
  listOpenTrades,
  listClosedTrades,
  findTradeByPosition,
  setTradeExit,
  updateTradeProgress,
  setTradeDepositUsd,
  settleTradeIfDone,
  tryLockTrade,
  unlockTrade,
  tradeLock,
} = await import("../src/state/trades.js");

const EXIT = {
  tp: { on: true, pct: 15 },
  sl: { on: true, pct: 25 },
  trail: { on: true, startPct: 5, distancePct: 3 },
};

function reset() {
  fs.rmSync(process.env.STATE_FILE, { force: true });
}

function newTrade(positions, extra = {}) {
  for (const p of positions) trackPosition(p, "PoolA", "AAA-SOL", "MintA", null, "spot");
  return createTrade({
    pool: "PoolA",
    pair: "AAA-SOL",
    baseMint: "MintA",
    positions,
    origin: "manual",
    exit: structuredClone(EXIT),
    ...extra,
  });
}

test("ids increment", () => {
  reset();
  const a = newTrade(["P1"]);
  const b = newTrade(["P2"]);
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(a.closed, false);
  assert.equal(a.depositUsd, null);
  assert.equal(a.peakPnlPct, null);
  assert.equal(a.trailArmed, false);
  assert.equal(a.closedAt, null);
  assert.equal(a.closePnlUsd, null);
  assert.deepEqual(
    listOpenTrades().map((t) => t.id),
    [1, 2]
  );
  assert.equal(getTrade(2).positions[0], "P2");
});

test("findTradeByPosition finds an open trade and returns null after settlement", () => {
  reset();
  const t = newTrade(["P1"]);
  assert.equal(findTradeByPosition("P1").id, t.id);
  assert.equal(findTradeByPosition("nope"), null);
  recordClose("P1", "tp", 5, { pnlUsd: 2 });
  assert.ok(settleTradeIfDone(t.id));
  assert.equal(findTradeByPosition("P1"), null);
  assert.equal(listOpenTrades().length, 0);
  assert.equal(listClosedTrades().length, 1);
});

test("setTradeExit merges per key and trail resets arming", () => {
  reset();
  const t = newTrade(["P1"]);
  updateTradeProgress(t.id, { peakPnlPct: 9, trailArmed: true });
  let cur = getTrade(t.id);
  assert.equal(cur.peakPnlPct, 9);
  assert.equal(cur.trailArmed, true);

  setTradeExit(t.id, { tp: { pct: 20 } });
  cur = getTrade(t.id);
  assert.deepEqual(cur.exit.tp, { on: true, pct: 20 });
  assert.equal(cur.trailArmed, true, "non-trail change keeps arming");
  assert.equal(cur.peakPnlPct, 9);

  setTradeExit(t.id, { trail: { startPct: 8 } });
  cur = getTrade(t.id);
  assert.deepEqual(cur.exit.trail, { on: true, startPct: 8, distancePct: 3 });
  assert.equal(cur.trailArmed, false);
  assert.equal(cur.peakPnlPct, null);
  assert.deepEqual(cur.exit.sl, EXIT.sl);
});

test("settle waits for every leg", () => {
  reset();
  const t = newTrade(["A", "B"]);
  setTradeDepositUsd(t.id, 100);
  recordClose("A", "tp", 5, { pnlUsd: 2 });
  assert.equal(settleTradeIfDone(t.id), null);
  assert.equal(getTrade(t.id).closed, false);

  recordClose("B", "tp", 1, { pnlUsd: 1, closeTx: "sig" });
  const done = settleTradeIfDone(t.id);
  assert.ok(done);
  assert.equal(done.closed, true);
  assert.equal(done.closePnlUsd, 3);
  assert.equal(done.closePnlPct, 3);
  assert.equal(done.closeTx, "sig");
  assert.equal(done.closeReason, "tp");
  assert.equal(done.closedAt, Math.max(getTrackedPosition("A").closedAt, getTrackedPosition("B").closedAt));
  assert.equal(getTrade(t.id).closed, true);
  // sudah settled: panggilan berikutnya tidak menyelesaikan ulang
  assert.equal(settleTradeIfDone(t.id), null);
});

test("settle keeps pnl null when a leg has no pnlUsd or deposit is unknown", () => {
  reset();
  const t = newTrade(["A", "B"]);
  setTradeDepositUsd(t.id, 100);
  recordClose("A", "tp", 5, { pnlUsd: 2 });
  recordClose("B", "tp", 1);
  const done = settleTradeIfDone(t.id);
  assert.equal(done.closePnlUsd, null);
  assert.equal(done.closePnlPct, null);

  const u = newTrade(["C"]);
  recordClose("C", "sl", -5, { pnlUsd: -1 });
  const d2 = settleTradeIfDone(u.id);
  assert.equal(d2.closePnlUsd, -1);
  assert.equal(d2.closePnlPct, null);
});

test("settle uses fallback for closed_not_detected", () => {
  reset();
  const t = newTrade(["A"]);
  markClosedNotDetected("A");
  const done = settleTradeIfDone(t.id);
  assert.equal(done.closeReason, "closed_outside");
  assert.equal(done.closePnlUsd, null);

  const u = newTrade(["B"]);
  markClosedNotDetected("B");
  const d2 = settleTradeIfDone(u.id, { fallbackReason: "custom" });
  assert.equal(d2.closeReason, "custom");
});

test("listClosedTrades filters by closedAt and sorts ascending", () => {
  reset();
  const a = newTrade(["A"]);
  const b = newTrade(["B"]);
  recordClose("A", "tp", 1, { pnlUsd: 1 });
  settleTradeIfDone(a.id);
  recordClose("B", "sl", -1, { pnlUsd: -1 });
  settleTradeIfDone(b.id);
  const all = listClosedTrades();
  assert.equal(all.length, 2);
  assert.ok(all[0].closedAt <= all[1].closedAt);
  assert.equal(listClosedTrades({ sinceMs: all[1].closedAt + 1 }).length, 0);
  assert.equal(listClosedTrades({ untilMs: all[0].closedAt - 1 }).length, 0);
  assert.equal(listClosedTrades({ sinceMs: 0, untilMs: all[1].closedAt }).length, 2);
});

test("lock is exclusive", () => {
  assert.equal(tradeLock(1), null);
  assert.equal(tryLockTrade(1, "close"), true);
  assert.equal(tryLockTrade(1, "claim"), false);
  assert.equal(tradeLock(1), "close");
  unlockTrade(1);
  assert.equal(tradeLock(1), null);
  assert.equal(tryLockTrade(1, "claim"), true);
  unlockTrade(1);
});

test("locks are never written to disk", () => {
  reset();
  const t = newTrade(["A"]);
  tryLockTrade(t.id, "close");
  assert.ok(!fs.readFileSync(process.env.STATE_FILE, "utf8").includes("lock"));
  unlockTrade(t.id);
});
