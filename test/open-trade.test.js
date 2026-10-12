import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import BN from "bn.js";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";

// Arahkan file state ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-opentrade-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");
process.env.WALLET_KEY_FILE = path.join(TMP, "wallet.key");

const { default: config } = await import("../src/config/index.js");
const { planOpen, executeOpen, SHAPES, SOL_BUFFER, MAX_TRADE_POSITIONS } = await import("../src/lp/open-trade.js");
const { getTrade, listOpenTrades } = await import("../src/state/trades.js");
const { getTrackedPosition } = await import("../src/state/positions.js");
const { setAutoFlipDefault } = await import("../src/state/settings.js");

const STRATEGY = { Spot: 0, Curve: 1, BidAsk: 2 };

function reset() {
  for (const f of ["STATE_FILE", "DECISION_LOG_FILE", "SETTINGS_FILE"]) fs.rmSync(process.env[f], { force: true });
}

// Fake SDK + pool + RPC. `autofill` = token (raw) yang dibutuhkan per 1 SOL di sisi SOL.
// Rent seperti RPC mainnet: (ukuran posisi + 128) x 6960 lamport; ukuran = 8112 + 112 per bin di atas 70.
const rentLamports = (bins) => (8112 + Math.max(0, bins - 70) * 112 + 128) * 6960;
// Lebar posisi multi2 tanpa ALT (70 + 91 x 3), ditulis literal agar tidak ikut parallelWidth.
const LEG_WIDTH = 343;

function fakeDeps({
  balance = 10,
  autofill = () => 1e9,
  landed = false,
  sendFails = 0,
  failSend = null,
  binStep = 100,
  held = 0,
} = {}) {
  const calls = { swap: [], swapToSol: [], send: [], init: [], multi: [], add: [], progress: [], keypairs: [] };
  let sendCount = 0;
  let tokenBalance = held;
  const sdk = {
    StrategyType: STRATEGY,
    DEFAULT_BIN_PER_POSITION: new BN(70),
    MAX_RESIZE_LENGTH: new BN(91),
    ALT_ADDRESS: {},
    autoFillXByStrategy: (active, step, amountY, ax, ay, lo, hi, type) => new BN(autofill(type)),
    autoFillYByStrategy: (active, step, amountX, ax, ay, lo, hi, type) => new BN(autofill(type)),
    getPositionRentExemption: async (connection, bins) => rentLamports(bins.toNumber()),
  };
  const pool = {
    lbPair: { binStep },
    getActiveBin: async () => ({ binId: 0, price: "1", pricePerToken: "1" }),
    refetchStates: async () => {},
    initializePositionAndAddLiquidityByStrategy: async (args) => {
      calls.init.push(args);
      return { kind: "init" };
    },
    addLiquidityByStrategy: async (args) => {
      calls.add.push(args);
      return { kind: "add" };
    },
    initializeMultiplePositionAndAddLiquidityByStrategy2: async (gen, x, y, strategy) => {
      calls.multi.push({ x, y, strategy });
      const count = Math.ceil((strategy.maxBinId - strategy.minBinId + 1) / LEG_WIDTH);
      const keypairs = await gen(count);
      calls.keypairs.push(...keypairs);
      return {
        instructionsByPositions: keypairs.map((kp) => ({
          positionKeypair: kp,
          transactionInstructions: [[IX], [IX]],
        })),
      };
    },
  };
  const deps = {
    loadSdk: async () => sdk,
    getConnection: () => ({
      getBalance: async () => balance * 1e9,
      getAccountInfo: async (pubkey) =>
        (typeof landed === "function" ? landed(pubkey, calls) : landed) ? { data: Buffer.alloc(0) } : null,
    }),
    getWallet: () => WALLET,
    getPoolInfo: async () => ({
      pool,
      baseMint: "MintA",
      baseIsX: true,
      unsupported: false,
      pairName: "AAA-SOL",
      collectFeeMode: 0,
    }),
    getMintDecimals: async () => 6,
    getTokenBalance: async () => tokenBalance,
    guardPoolPrice: async ({ getActiveBin }) => ({
      activeBin: await getActiveBin(),
      guard: { ok: true, unavailable: false, deviationPct: 0.5 },
      exhausted: false,
      attempts: 1,
    }),
    swapSolToToken: async (mint, sol) => {
      calls.swap.push([mint, sol]);
      tokenBalance += 123.456;
      return { success: true, amountOut: 123.456 };
    },
    swapToSol: async (mint, amount) => {
      calls.swapToSol.push([mint, amount]);
      return { success: true };
    },
    buildFeePlan: () => ({ mode: "none", priorityMicroLamports: 0, computeUnitLimit: 0, jitoTipLamports: 0 }),
    checkFeeCap: () => ({ ok: true, totalSol: 0, cap: 0.01 }),
    sendAndConfirmRobust: async ({ tx, signers }) => {
      calls.send.push({ tx, signers });
      sendCount++;
      if (sendCount <= sendFails || failSend?.(sendCount)) {
        const e = new Error("Tx tidak terkonfirmasi");
        e.signature = "sig-fail";
        throw e;
      }
      return { signature: `sig-${sendCount}` };
    },
  };
  return { deps, calls, sdk, pool };
}

const WALLET = Keypair.generate();
const IX = new TransactionInstruction({ keys: [], programId: SystemProgram.programId, data: Buffer.alloc(0) });

async function withLive(fn) {
  const saved = config.dryRun;
  config.dryRun = false;
  try {
    return await fn();
  } finally {
    config.dryRun = saved;
  }
}

const base = { poolAddress: "PoolA", depositSol: 1, below: 20, above: 20, shape: "spot" };

test("constants", () => {
  assert.deepEqual(SHAPES, ["spot", "curve", "bid_ask", "mixed"]);
  assert.equal(SOL_BUFFER, 0.08);
  assert.equal(MAX_TRADE_POSITIONS, 10);
});

test("SOL-only plan has no swap", async () => {
  const { deps } = fakeDeps();
  const plan = await planOpen({ ...base, below: 45, above: 0, deps });
  assert.equal(plan.error, undefined);
  assert.equal(plan.swapSol, 0);
  assert.equal(plan.solSideSol, 1);
  assert.ok(plan.lowerBin < plan.upperBin);
  assert.equal(plan.upperBin, 0);
});

test("two-sided plan splits by SDK autofill", async () => {
  const { deps } = fakeDeps({ autofill: () => 1e9 });
  const plan = await planOpen({ ...base, deps });
  assert.ok(Math.abs(plan.swapSol - 0.5) < 1e-9, `swapSol ${plan.swapSol}`);
  assert.ok(Math.abs(plan.solSideSol - 0.5) < 1e-9);
  assert.equal(plan.positionCount, 1);
  assert.equal(plan.pair, "AAA-SOL");
  assert.equal(plan.binStep, 100);
  assert.ok(plan.lowSol > 0 && plan.lowSol < plan.highSol);
  assert.equal(plan.priceGuard.ok, true);
});

test("two-sided split converts with the raw bin price when SOL is token X", async () => {
  const { deps } = fakeDeps({ autofill: () => 2e9 });
  const info = await deps.getPoolInfo();
  info.baseIsX = false;
  info.pool.getActiveBin = async () => ({ binId: 0, price: "2", pricePerToken: "2" });
  deps.getPoolInfo = async () => info;
  const plan = await planOpen({ ...base, deps });
  // y1 = 2e9 raw token; v1 = y1 / price = 1e9 lamports -> setengah-setengah.
  assert.ok(Math.abs(plan.swapSol - 0.5) < 1e-9, `swapSol ${plan.swapSol}`);
});

test("mixed splits per part", async () => {
  const { deps } = fakeDeps({ autofill: (type) => (type === STRATEGY.BidAsk ? 1e9 : 3e9) });
  const plan = await planOpen({ ...base, shape: "mixed", deps });
  // BidAsk 0.7: sol 0.35 swap 0.35. Spot 0.3: sol 0.075 swap 0.225.
  assert.ok(Math.abs(plan.swapSol - 0.575) < 1e-9, `swapSol ${plan.swapSol}`);
  assert.ok(Math.abs(plan.solSideSol - 0.425) < 1e-9);
  assert.deepEqual(
    plan.parts.map((p) => p.strategy),
    ["BidAsk", "Spot"]
  );
});

test("insufficient SOL refused before swap", async () => {
  const { deps, calls } = fakeDeps({ balance: 0.5 });
  const plan = await planOpen({ ...base, depositSol: 0.5, deps });
  assert.match(plan.error, /short/);
  assert.match(plan.error, /need 0\.5800, have 0\.5000 \(short 0\.0800\)/);

  // Saldo turun setelah konfirmasi wizard: executeOpen juga menolak sebelum swap.
  const { deps: ok } = fakeDeps();
  const good = await planOpen({ ...base, depositSol: 0.5, deps: ok });
  const res = await withLive(() => executeOpen(good, { deps }));
  assert.equal(res.success, false);
  assert.match(res.error, /short/);
  assert.equal(calls.swap.length, 0);
  assert.equal(calls.send.length, 0);
});

test("rent above one standard position is required (several positions)", async () => {
  // binStep 10, 20/20 -> 406 bin = posisi 343 + 63 bin. Rent 0.2702 + 0.0574 - standar 0.0574.
  const { deps } = fakeDeps({ balance: 1.3, binStep: 10 });
  const plan = await planOpen({ ...base, deps });
  assert.equal(plan.error, "Not enough SOL: need 1.3502, have 1.3000 (short 0.0502)");
});

test("wide single position with deposit + 0.09 is refused before swap", async () => {
  // binStep 100, 65/65 -> 156 bin dalam satu posisi: rent 0.1244, 0.0670 di atas posisi standar.
  const { deps: rich } = fakeDeps();
  const plan = await planOpen({ ...base, below: 65, above: 65, deps: rich });
  assert.equal(plan.binCount, 156);
  assert.equal(plan.positionCount, 1);
  assert.ok(Math.abs(plan.rentSol - rentLamports(156) / 1e9) < 1e-12);

  const { deps, calls } = fakeDeps({ balance: 1.09 });
  const refused = await planOpen({ ...base, below: 65, above: 65, deps });
  assert.equal(refused.error, "Not enough SOL: need 1.1470, have 1.0900 (short 0.0570)");
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, false);
  assert.match(res.error, /short 0\.0570/);
  assert.equal(calls.swap.length, 0);
});

test("too many positions refused", async () => {
  // binStep 1, 20/20 -> 4055 bin -> ceil(4055 / 343) = 12 posisi multi2.
  const { deps } = fakeDeps({ binStep: 1 });
  const plan = await planOpen({ ...base, deps });
  assert.equal(plan.error, "range too wide: 12 positions (max 10)");
});

test("dry run sends nothing", async () => {
  const { deps, calls } = fakeDeps();
  const plan = await planOpen({ ...base, deps });
  const saved = config.dryRun;
  config.dryRun = true;
  try {
    const progress = [];
    const res = await executeOpen(plan, { onProgress: (t) => progress.push(t), deps });
    assert.deepEqual(res, { success: true, dryRun: true });
    assert.deepEqual(progress, ["dry run — nothing sent"]);
  } finally {
    config.dryRun = saved;
  }
  assert.equal(calls.swap.length, 0);
  assert.equal(calls.send.length, 0);
});

test("single position opens, tracks and creates a manual trade", async () => {
  reset();
  const { deps, calls } = fakeDeps();
  const plan = await planOpen({ ...base, deps });
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, true);
  assert.equal(calls.swap.length, 1);
  assert.ok(Math.abs(calls.swap[0][1] - 0.5) < 1e-9);
  assert.equal(calls.init.length, 1);
  // 123.456 token (6 desimal) di sisi X, 0.5 SOL di sisi Y.
  assert.equal(calls.init[0].totalXAmount.toString(), "123456000");
  assert.equal(calls.init[0].totalYAmount.toString(), "500000000");
  assert.equal(calls.init[0].strategy.strategyType, STRATEGY.Spot);
  assert.equal(calls.init[0].slippage, config.entry.activeBinSlippagePct);
  const trade = getTrade(res.trade.id);
  assert.equal(trade.origin, "manual");
  assert.equal(trade.shape, "spot");
  assert.equal(trade.depositSol, 1);
  assert.deepEqual(trade.range, {
    below: 20,
    above: 20,
    lowerBin: plan.lowerBin,
    upperBin: plan.upperBin,
    activeBin: plan.activeBin,
  });
  assert.equal("autoFlip" in trade, false);
  assert.deepEqual(trade.positions, res.positions);
  assert.equal(getTrackedPosition(res.positions[0]).mode, "bidask:double");
});

test("failed open with nothing landed reverts swap", async () => {
  reset();
  // Token milik user yang sudah ada (500) tidak ikut dijual.
  const { deps, calls } = fakeDeps({ sendFails: 1, landed: false, held: 500 });
  const plan = await planOpen({ ...base, deps });
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, false);
  assert.equal(calls.swapToSol.length, 1);
  assert.deepEqual(calls.swapToSol[0], ["MintA", 123.456]);
  assert.equal(listOpenTrades().length, 0);
});

test("error after the swap but before any send reverts swap", async () => {
  reset();
  const { deps, calls, pool } = fakeDeps();
  const plan = await planOpen({ ...base, deps });
  pool.refetchStates = async () => {
    throw new Error("rpc down");
  };
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, false);
  assert.equal(res.error, "rpc down");
  assert.equal(calls.send.length, 0);
  assert.equal(calls.swapToSol.length, 1);
});

test("failed confirm but landed counts as success", async () => {
  reset();
  const { deps, calls } = fakeDeps({ sendFails: 1, landed: true });
  const plan = await planOpen({ ...base, deps });
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, true);
  assert.equal(calls.swapToSol.length, 0);
  assert.equal(getTrade(res.trade.id).positions.length, 1);
});

test("price guard exhausted stops before swap", async () => {
  const { deps, calls } = fakeDeps();
  const plan = await planOpen({ ...base, deps });
  deps.guardPoolPrice = async ({ getActiveBin }) => ({
    activeBin: await getActiveBin(),
    guard: { ok: false, deviationPct: 30 },
    exhausted: true,
    attempts: 3,
  });
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, false);
  assert.match(res.error, /30\.0%/);
  assert.equal(calls.swap.length, 0);
});

test("wide range opens several positions under one trade", async () => {
  reset();
  // binStep 10: 20/20 -> ~400 bin -> 2 posisi paralel (343 bin per posisi).
  const { deps, calls } = fakeDeps({ binStep: 10 });
  const plan = await planOpen({ ...base, deps });
  assert.equal(plan.binCount, 406);
  assert.equal(plan.positionCount, 2);
  assert.ok(Math.abs(plan.rentSol - (rentLamports(343) + rentLamports(63)) / 1e9) < 1e-12);
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, true);
  assert.equal(calls.init.length, 0);
  assert.equal(calls.multi.length, 1);
  assert.equal(calls.send.length, 4); // 2 posisi x 2 tx
  assert.equal(res.positions.length, 2);
  assert.equal(listOpenTrades().length, 1);
  // Tiap tx ditandatangani wallet + keypair posisinya.
  assert.equal(calls.send[0].signers[1].publicKey.toString(), res.positions[0]);
  assert.equal(calls.send[3].signers[1].publicKey.toString(), res.positions[1]);
  // Mode dari lebar seluruh range (406 >= 200), juga untuk leg terakhir yang hanya 63 bin.
  assert.equal(getTrackedPosition(res.positions[0]).mode, "spot");
  assert.equal(getTrackedPosition(res.positions[1]).mode, "spot");
  assert.equal(calls.multi[0].strategy.minBinId, plan.lowerBin);
  assert.equal(calls.multi[0].strategy.maxBinId, plan.upperBin);
});

test("SOL-only narrow trade is tracked as bidask:sol", async () => {
  reset();
  const { deps, calls } = fakeDeps();
  const plan = await planOpen({ ...base, below: 20, above: 0, deps });
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, true);
  assert.equal(calls.swap.length, 0);
  assert.equal(getTrackedPosition(res.positions[0]).mode, "bidask:sol");
});

test("partial multi-position open keeps landed legs and reverts unused tokens", async () => {
  reset();
  // 2 posisi x 2 tx; tx ke-3 (posisi ke-2) gagal, hanya posisi pertama ada on-chain.
  const { deps, calls } = fakeDeps({
    binStep: 10,
    failSend: (n) => n === 3,
    landed: (pubkey, c) => pubkey.equals(c.keypairs[0].publicKey),
  });
  const plan = await planOpen({ ...base, shape: "mixed", deps });
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, true);
  assert.deepEqual(res.positions, [calls.keypairs[0].publicKey.toString()]);
  assert.equal(getTrackedPosition(calls.keypairs[1].publicKey.toString()), null);
  assert.deepEqual(getTrade(res.trade.id).positions, res.positions);
  assert.match(res.warning, /Open incomplete: 1 of 2 positions/);
  assert.match(res.warning, /Spot layer skipped/);
  assert.match(res.warning, /swapped back to SOL/);
  assert.equal(calls.add.length, 0);
  assert.equal(calls.swapToSol.length, 1);
  assert.ok(calls.swapToSol[0][1] > 0 && calls.swapToSol[0][1] <= 123.456);
});

test("mixed adds a Spot layer to the same position", async () => {
  reset();
  const { deps, calls } = fakeDeps({ autofill: () => 1e9 });
  const plan = await planOpen({ ...base, shape: "mixed", deps });
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, true);
  assert.equal(res.warning, undefined);
  assert.equal(calls.init[0].strategy.strategyType, STRATEGY.BidAsk);
  assert.equal(calls.add.length, 1);
  assert.equal(calls.add[0].strategy.strategyType, STRATEGY.Spot);
  assert.equal(calls.add[0].positionPubKey.toString(), res.positions[0]);
  // Spot 30%: 0.15 SOL di sisi Y; token 30% dari hasil swap.
  assert.equal(calls.add[0].totalYAmount.toString(), "150000000");
  assert.equal(calls.add[0].totalXAmount.toString(), "37036800");
});

test("mixed Spot layer failure keeps the trade with a warning", async () => {
  reset();
  const { deps, calls } = fakeDeps();
  const plan = await planOpen({ ...base, shape: "mixed", deps });
  const send = deps.sendAndConfirmRobust;
  deps.sendAndConfirmRobust = async (args) => {
    if (args.tx.kind === "add") throw new Error("boom");
    return send(args);
  };
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal(res.success, true);
  assert.match(res.warning, /Spot layer \(30%\) failed/);
  assert.match(res.warning, /swapped back to SOL/);
  assert.equal(calls.swapToSol.length, 1);
  assert.equal(getTrade(res.trade.id).closed, false);
});

test("bid_ask and mixed opens take the auto flip default; spot does not", async () => {
  for (const [shape, expected] of [
    ["bid_ask", { pct: 30 }],
    ["mixed", { pct: 30 }],
    ["spot", undefined],
  ]) {
    reset();
    setAutoFlipDefault(30);
    const { deps } = fakeDeps();
    const plan = await planOpen({ ...base, shape, deps });
    const res = await withLive(() => executeOpen(plan, { deps }));
    assert.equal(res.success, true, shape);
    assert.deepEqual(getTrade(res.trade.id).autoFlip, expected, shape);
  }
});

test("bid_ask open without an auto flip default has no autoFlip", async () => {
  reset();
  const { deps } = fakeDeps();
  const plan = await planOpen({ ...base, shape: "bid_ask", deps });
  const res = await withLive(() => executeOpen(plan, { deps }));
  assert.equal("autoFlip" in getTrade(res.trade.id), false);
});
