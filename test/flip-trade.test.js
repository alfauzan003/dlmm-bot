import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-flip-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { selectFlipBins, flipRange, canFlip } = await import("../src/lp/flip-trade.js");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const bins = (from, to, tokenAmount = 1) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ binId: from + i, tokenAmount }));

test("selectFlipBins: baseIsX takes bins above active, skips active and empty", () => {
  const r = selectFlipBins({
    activeBinId: 100,
    baseIsX: true,
    legs: [
      {
        position: "P1",
        bins: [
          { binId: 98, tokenAmount: 0 },
          { binId: 100, tokenAmount: 5 },
          { binId: 101, tokenAmount: 3 },
          { binId: 102, tokenAmount: 0 },
          { binId: 103, tokenAmount: 2 },
        ],
      },
    ],
  });
  assert.deepEqual(r, { binCount: 2, legs: [{ position: "P1", fromBinId: 101, toBinId: 103 }] });
});

test("selectFlipBins: token Y takes bins below active", () => {
  const r = selectFlipBins({
    activeBinId: 100,
    baseIsX: false,
    legs: [{ position: "P1", bins: [...bins(97, 99), { binId: 100, tokenAmount: 4 }, { binId: 101, tokenAmount: 4 }] }],
  });
  assert.deepEqual(r, { binCount: 3, legs: [{ position: "P1", fromBinId: 97, toBinId: 99 }] });
});

test("selectFlipBins: caps at maxBins nearest active across legs", () => {
  const r = selectFlipBins({
    activeBinId: 100,
    baseIsX: true,
    maxBins: 70,
    legs: [
      { position: "P1", bins: bins(101, 140) },
      { position: "P2", bins: bins(141, 200) },
    ],
  });
  assert.deepEqual(r, {
    binCount: 70,
    legs: [
      { position: "P1", fromBinId: 101, toBinId: 140 },
      { position: "P2", fromBinId: 141, toBinId: 170 },
    ],
  });
});

test("selectFlipBins: default cap is 70", () => {
  const r = selectFlipBins({ activeBinId: 0, baseIsX: true, legs: [{ position: "P1", bins: bins(1, 100) }] });
  assert.equal(r.binCount, 70);
  assert.deepEqual(r.legs, [{ position: "P1", fromBinId: 1, toBinId: 70 }]);
});

test("selectFlipBins: nothing on token side → binCount 0, legs []", () => {
  const r = selectFlipBins({ activeBinId: 100, baseIsX: true, legs: [{ position: "P1", bins: bins(80, 100) }] });
  assert.deepEqual(r, { binCount: 0, legs: [] });
});

test("flipRange mirrors on the token side", () => {
  assert.deepEqual(flipRange(100, 5, true), { minBinId: 101, maxBinId: 105 });
  assert.deepEqual(flipRange(100, 5, false), { minBinId: 95, maxBinId: 99 });
});

test("canFlip only for bid_ask and mixed", () => {
  assert.equal(canFlip({ shape: "bid_ask" }), true);
  assert.equal(canFlip({ shape: "mixed" }), true);
  assert.equal(canFlip({ shape: "spot" }), false);
  assert.equal(canFlip({ shape: "curve" }), false);
  assert.equal(canFlip({ shape: null }), false);
  assert.equal(canFlip(undefined), false);
});

// --- planFlip / flipTrade ---

const { planFlip, flipTrade } = await import("../src/lp/flip-trade.js");
const { tokenOnlyRange } = await import("../src/meteora/open-token-position.js");
const { trackPosition, recordClose } = await import("../src/state/positions.js");
const { createTrade, getTrade, tryLockTrade, unlockTrade, tradeLock } = await import("../src/state/trades.js");
const { listKeepMints } = await import("../src/state/keep-mints.js");
const { isEntryInProgressPool, getEntryInProgressMints } = await import("../src/entry/runtime.js");

const EXIT = {
  tp: { on: true, pct: 15 },
  sl: { on: true, pct: 25 },
  trail: { on: true, startPct: 5, distancePct: 3 },
};

function newTrade({ shape = "bid_ask", positions = ["L1"] } = {}) {
  fs.rmSync(process.env.STATE_FILE, { force: true });
  for (const p of positions) trackPosition(p, "PoolA", "AAA-SOL", "MintA", null, "bidask:double");
  return createTrade({
    pool: "PoolA",
    pair: "AAA-SOL",
    baseMint: "MintA",
    positions,
    shape,
    origin: "manual",
    exit: EXIT,
  });
}

// Pool palsu: L1 punya token di bin 101..110 (aktif 100, token = X). Tiap removeBins +30 token.
function fakeDeps(overrides = {}) {
  const calls = { readLegs: 0, removeBins: [], open: [], sleep: 0 };
  let balance = 50;
  const deps = {
    dryRun: false,
    loadPool: async () => ({ pool: { id: "pool" }, baseIsX: true }),
    readLegs: async () => {
      calls.readLegs++;
      return { activeBinId: 100, legs: [{ position: "L1", bins: bins(95, 110) }] };
    },
    readActiveBinId: async () => 100,
    removeBins: async (pool, leg) => {
      calls.removeBins.push(leg);
      balance += 30;
    },
    getTokenBalance: async () => balance,
    openTokenOnlyPosition: async (args) => {
      calls.open.push(args);
      return { success: true, position: "NewPos" };
    },
    sleep: async () => {
      calls.sleep++;
    },
    ...overrides,
  };
  return { deps, calls };
}

test("tokenOnlyRange uses explicit bins when given, else the fallback range", () => {
  assert.deepEqual(tokenOnlyRange(100, { binsBelow: 2, binsAbove: 3 }), { minBinId: 98, maxBinId: 103 });
  assert.deepEqual(tokenOnlyRange(100, { binsBelow: 2, binsAbove: 3, minBinId: 101, maxBinId: 110 }), {
    minBinId: 101,
    maxBinId: 110,
  });
});

test("planFlip refuses ineligible shape and full trades", async () => {
  const { deps } = fakeDeps();
  assert.ok((await planFlip(newTrade({ shape: "spot" }), { deps })).error);
  const full = newTrade({ positions: Array.from({ length: 10 }, (_, i) => `L${i + 1}`) });
  assert.match((await planFlip(full, { deps })).error, /too many positions/);
});

test("planFlip returns legs and the mirrored range", async () => {
  const { deps } = fakeDeps();
  const plan = await planFlip(newTrade(), { deps });
  assert.equal(plan.binCount, 10);
  assert.deepEqual(plan.legs, [{ position: "L1", fromBinId: 101, toBinId: 110 }]);
  assert.deepEqual(plan.newRange, { minBinId: 101, maxBinId: 110 });
});

test("planFlip ignores legs closed in state and positions outside the trade", async () => {
  const trade = newTrade({ positions: ["L1", "L2"] });
  recordClose("L1", "manual", 0, { pnlUsd: 0 });
  const { deps } = fakeDeps({
    readLegs: async () => ({
      activeBinId: 100,
      legs: [
        { position: "L1", bins: bins(101, 110) },
        { position: "L2", bins: bins(101, 103) },
        { position: "Other", bins: bins(101, 150) },
      ],
    }),
  });
  const plan = await planFlip(trade, { deps });
  assert.equal(plan.binCount, 3);
  assert.deepEqual(plan.legs, [{ position: "L2", fromBinId: 101, toBinId: 103 }]);
});

test("flipTrade returns busy when the trade is locked", async () => {
  const trade = newTrade();
  tryLockTrade(trade.id, "claim");
  const { deps, calls } = fakeDeps();
  try {
    const res = await flipTrade(trade, { deps });
    assert.equal(res.busy, true);
    assert.equal(calls.readLegs, 0);
  } finally {
    unlockTrade(trade.id);
  }
});

test("flipTrade with nothing to flip sends no tx", async () => {
  const { deps, calls } = fakeDeps({
    readLegs: async () => ({ activeBinId: 100, legs: [{ position: "L1", bins: bins(90, 100) }] }),
  });
  const res = await flipTrade(newTrade(), { deps });
  assert.equal(res.success, false);
  assert.equal(res.binCount, 0);
  assert.equal(calls.removeBins.length, 0);
  assert.equal(calls.open.length, 0);
});

test("flipTrade in dry run removes nothing", async () => {
  const { deps, calls } = fakeDeps({ dryRun: true });
  const res = await flipTrade(newTrade(), { deps });
  assert.deepEqual(res, { success: true, dryRun: true, binCount: 10 });
  assert.equal(calls.removeBins.length, 0);
  assert.equal(calls.open.length, 0);
});

test("flipTrade re-plans with fresh pool data", async () => {
  const { deps, calls } = fakeDeps({ readActiveBinId: async () => 104 });
  await flipTrade(newTrade(), { deps });
  assert.equal(calls.readLegs, 1);
  // Bin aktif saat setor ulang (104) yang dipakai untuk rentang baru.
  assert.equal(calls.open[0].minBinId, 105);
  assert.equal(calls.open[0].maxBinId, 114);
});

test("re-deposits only the withdrawn delta", async () => {
  const { deps, calls } = fakeDeps();
  await flipTrade(newTrade(), { deps });
  assert.deepEqual(calls.removeBins, [{ position: "L1", fromBinId: 101, toBinId: 110 }]);
  assert.equal(calls.open.length, 1);
  assert.equal(calls.open[0].tokenAmountUi, 30);
  assert.equal(calls.open[0].poolAddress, "PoolA");
  assert.equal(calls.open[0].baseMint, "MintA");
  assert.equal(calls.open[0].distribution, "bid_ask");
  assert.equal(calls.open[0].minBinId, 101);
  assert.equal(calls.open[0].maxBinId, 110);
});

test("success adds the leg to positions and flipLegs", async () => {
  const trade = newTrade();
  const { deps } = fakeDeps();
  const res = await flipTrade(trade, { deps });
  assert.deepEqual(res, { success: true, binCount: 10, tokenAmount: 30, position: "NewPos" });
  const t = getTrade(trade.id);
  assert.deepEqual(t.positions, ["L1", "NewPos"]);
  assert.deepEqual(t.flipLegs, ["NewPos"]);
  assert.equal(tradeLock(trade.id), null);
});

test("balance never increases → redepositFailed + keepMint", async () => {
  const { deps, calls } = fakeDeps({ removeBins: async () => {} });
  const res = await flipTrade(newTrade(), { deps });
  assert.equal(res.success, false);
  assert.equal(res.redepositFailed, true);
  assert.equal(calls.sleep, 3);
  assert.equal(calls.open.length, 0);
  assert.ok(listKeepMints().includes("MintA"));
});

test("every withdraw fails → error, no keepMint", async () => {
  const { deps, calls } = fakeDeps({
    removeBins: async () => {
      throw new Error("rpc down");
    },
  });
  const res = await flipTrade(newTrade(), { deps });
  assert.equal(res.success, false);
  assert.equal(res.error, "withdraw failed");
  assert.equal(calls.open.length, 0);
  assert.ok(!listKeepMints().includes("MintA"));
});

test("open failure → redepositFailed + keepMint, trade unchanged", async () => {
  const trade = newTrade();
  const { deps } = fakeDeps({ openTokenOnlyPosition: async () => ({ success: false, error: "slippage" }) });
  const res = await flipTrade(trade, { deps });
  assert.equal(res.redepositFailed, true);
  assert.equal(res.tokenAmount, 30);
  assert.ok(listKeepMints().includes("MintA"));
  assert.deepEqual(getTrade(trade.id).positions, ["L1"]);
});

test("releases lock and guards when deposit throws", async () => {
  const trade = newTrade();
  const { deps } = fakeDeps({
    openTokenOnlyPosition: async () => {
      throw new Error("boom");
    },
  });
  const res = await flipTrade(trade, { deps });
  assert.equal(res.redepositFailed, true);
  assert.ok(listKeepMints().includes("MintA"));
  assert.equal(tradeLock(trade.id), null);
  assert.equal(isEntryInProgressPool("PoolA"), false);
  assert.equal(getEntryInProgressMints().has("MintA"), false);
});
