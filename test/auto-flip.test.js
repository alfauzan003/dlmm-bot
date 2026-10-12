import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-autoflip-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { crossedPct, estimateOpenActive, runAutoFlips, autoFlipMessage } = await import("../src/exit/auto-flip.js");
const { trackPosition, recordClose } = await import("../src/state/positions.js");
const { createTrade, getTrade, tryLockTrade, unlockTrade } = await import("../src/state/trades.js");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const EXIT = {
  tp: { on: false, pct: 15 },
  sl: { on: false, pct: 25 },
  trail: { on: false, startPct: 5, distancePct: 3 },
};

const live = (active, xIsSol = false, addr = "L1") =>
  new Map([[addr, { position: addr, activeBin: active, lowerBin: 0, upperBin: 0, xIsSol }]]);

// Token = X: SOL di bin 0..99 di bawah harga buka (bin 100).
const rangeX = { below: 50, above: 0, lowerBin: 0, upperBin: 100, activeBin: 100 };

test("crossedPct: token X, price falling moves active down", () => {
  const trade = { positions: ["L1"], range: rangeX };
  assert.equal(crossedPct(trade, live(100)), 0);
  assert.equal(crossedPct(trade, live(70)), 30);
  assert.equal(crossedPct(trade, live(0)), 100);
});

test("crossedPct: SOL is X, price falling moves active up", () => {
  const trade = { positions: ["L1"], range: { below: 50, above: 0, lowerBin: 100, upperBin: 200, activeBin: 100 } };
  assert.equal(crossedPct(trade, live(100, true)), 0);
  assert.equal(crossedPct(trade, live(125, true)), 25);
});

test("crossedPct clamps to 0..100", () => {
  const trade = { positions: ["L1"], range: rangeX };
  assert.equal(crossedPct(trade, live(130)), 0);
  assert.equal(crossedPct(trade, live(-20)), 100);
});

test("crossedPct is null without range or live data", () => {
  assert.equal(crossedPct({ positions: ["L1"], range: null }, live(50)), null);
  assert.equal(crossedPct({ positions: ["L1"], range: rangeX }, new Map()), null);
  assert.equal(crossedPct({ positions: ["L1"], range: rangeX }, null), null);
});

test("crossedPct ignores legs closed in state", () => {
  const trade = { positions: ["L1"], range: rangeX };
  assert.equal(crossedPct(trade, live(70), { isClosed: () => true }), null);
});

test("estimateOpenActive: SOL-only range is exact", () => {
  assert.equal(estimateOpenActive({ below: 50, above: 0, lowerBin: 0, upperBin: 100 }, false), 100);
  assert.equal(estimateOpenActive({ below: 50, above: 0, lowerBin: 100, upperBin: 200 }, true), 100);
});

test("estimateOpenActive: two-sided range splits by log price distance", () => {
  // ln(1/(1-0.5)) = 0.693, ln(1.5) = 0.405 -> 63.1% dari lebar 100 di sisi SOL.
  assert.equal(estimateOpenActive({ below: 50, above: 50, lowerBin: 0, upperBin: 100 }, false), 63);
  assert.equal(estimateOpenActive({ below: 50, above: 50, lowerBin: 0, upperBin: 100 }, true), 37);
});

test("crossedPct uses the estimate when the open bin was not stored", () => {
  const trade = { positions: ["L1"], range: { below: 50, above: 0, lowerBin: 0, upperBin: 100 } };
  assert.equal(crossedPct(trade, live(80)), 20);
});

// --- runAutoFlips ---

function newTrade({ shape = "bid_ask", autoFlip = { pct: 30 } } = {}) {
  fs.rmSync(process.env.STATE_FILE, { force: true });
  trackPosition("L1", "PoolA", "AAA-SOL", "MintA", null, "bidask:double");
  return createTrade({
    pool: "PoolA",
    pair: "AAA-SOL",
    baseMint: "MintA",
    positions: ["L1"],
    shape,
    range: rangeX,
    origin: "manual",
    exit: EXIT,
    autoFlip,
  });
}

function fakeDeps(result = { success: true, binCount: 30, tokenAmount: 12.5, position: "New" }) {
  const calls = { flip: [], notify: [] };
  return {
    calls,
    deps: {
      flipTrade: async (t) => {
        calls.flip.push(t.id);
        return result;
      },
      notify: (text) => calls.notify.push(text),
    },
  };
}

const positions = (active) => [...live(active).values()];

test("runAutoFlips does nothing below the threshold", async () => {
  const trade = newTrade();
  const { deps, calls } = fakeDeps();
  await runAutoFlips(positions(80), { deps });
  assert.equal(calls.flip.length, 0);
  assert.deepEqual(getTrade(trade.id).autoFlip, { pct: 30 });
});

test("runAutoFlips flips at the threshold, turns off and notifies", async () => {
  const trade = newTrade();
  const { deps, calls } = fakeDeps();
  await runAutoFlips(positions(70), { deps });
  assert.deepEqual(calls.flip, [trade.id]);
  assert.equal(getTrade(trade.id).autoFlip, undefined);
  assert.deepEqual(calls.notify, [
    `🤖 Auto flip #${trade.id} AAA-SOL at 30% crossed: flipped 30 bins (12.5 token) → new position over 30 bins.`,
  ]);
});

test("runAutoFlips keeps auto flip on when the trade or pool is busy", async () => {
  for (const result of [
    { success: false, busy: true, binCount: 0 },
    { success: false, poolBusy: true, error: "pool is busy", binCount: 0 },
  ]) {
    const trade = newTrade();
    const { deps, calls } = fakeDeps(result);
    await runAutoFlips(positions(50), { deps });
    assert.equal(calls.flip.length, 1);
    assert.deepEqual(getTrade(trade.id).autoFlip, { pct: 30 });
    assert.equal(calls.notify.length, 0);
  }
});

test("runAutoFlips keeps auto flip on when flipTrade throws", async () => {
  const trade = newTrade();
  const { deps, calls } = fakeDeps();
  deps.flipTrade = async () => {
    throw new Error("rpc down");
  };
  await runAutoFlips(positions(50), { deps });
  assert.deepEqual(getTrade(trade.id).autoFlip, { pct: 30 });
  assert.equal(calls.notify.length, 0);
});

test("runAutoFlips turns off and reports failures", async () => {
  const cases = [
    [{ success: false, error: "fee estimate too high", binCount: 0 }, "failed: fee estimate too high."],
    [
      { success: false, redepositFailed: true, binCount: 5, tokenAmount: 3 },
      "failed: withdrawn but re-deposit failed — token kept in wallet.",
    ],
    [{ success: false, binCount: 0 }, "failed: nothing to flip — no token-only bins yet."],
  ];
  for (const [result, tail] of cases) {
    const trade = newTrade();
    const { deps, calls } = fakeDeps(result);
    await runAutoFlips(positions(50), { deps });
    assert.equal(getTrade(trade.id).autoFlip, undefined);
    assert.equal(calls.notify.length, 1);
    assert.ok(calls.notify[0].startsWith(`⚠️ Auto flip #${trade.id} AAA-SOL at 50% crossed `), calls.notify[0]);
    assert.ok(calls.notify[0].endsWith(`${tail} Auto flip turned off.`), calls.notify[0]);
  }
});

test("runAutoFlips in dry run turns off and says so", async () => {
  const trade = newTrade();
  const { deps, calls } = fakeDeps({ success: true, dryRun: true, binCount: 30 });
  await runAutoFlips(positions(70), { deps });
  assert.equal(getTrade(trade.id).autoFlip, undefined);
  assert.deepEqual(calls.notify, [
    `🧪 DRY RUN — auto flip #${trade.id} AAA-SOL at 30% crossed would flip 30 bins. Auto flip turned off.`,
  ]);
});

test("runAutoFlips skips locked, ineligible, closed-leg and off trades", async () => {
  const locked = newTrade();
  tryLockTrade(locked.id, "claim");
  try {
    const { deps, calls } = fakeDeps();
    await runAutoFlips(positions(50), { deps });
    assert.equal(calls.flip.length, 0);
  } finally {
    unlockTrade(locked.id);
  }
  for (const opts of [{ shape: "spot" }, { autoFlip: null }]) {
    newTrade(opts);
    const { deps, calls } = fakeDeps();
    await runAutoFlips(positions(50), { deps });
    assert.equal(calls.flip.length, 0);
  }
  newTrade();
  recordClose("L1", "manual", 0, { pnlUsd: 0 });
  const { deps, calls } = fakeDeps();
  await runAutoFlips(positions(50), { deps });
  assert.equal(calls.flip.length, 0);
});

test("autoFlipMessage rounds the crossed percentage", () => {
  const text = autoFlipMessage({ id: 3, pair: "B-SOL" }, 31.6, {
    success: true,
    binCount: 2,
    tokenAmount: 1234.56789,
  });
  assert.equal(
    text,
    "🤖 Auto flip #3 B-SOL at 32% crossed: flipped 2 bins (1,234.5679 token) → new position over 2 bins."
  );
});
