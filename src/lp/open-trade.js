import { Keypair, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { getTokenBalance, getMintDecimals } from "../solana/balances.js";
import { swapSolToToken, swapToSol } from "../solana/swap.js";
import { buildFeePlan, checkFeeCap } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getPoolInfo } from "../entry/pool-info.js";
import { guardPoolPrice } from "../entry/price-guard.js";
import {
  addEntryInProgressMint,
  removeEntryInProgressMint,
  addEntryInProgressPool,
  removeEntryInProgressPool,
} from "../entry/runtime.js";
import { trackPosition } from "../state/positions.js";
import { createTrade, updateTradeMeta } from "../state/trades.js";
import { exitPresetForNewTrade, getSettings } from "../state/settings.js";
import { pctToBinRange, binPriceBounds } from "./range.js";
import { splitParts, parallelWidth, chunkRange, spotPieces, legMode } from "./open-split.js";

export const SHAPES = ["spot", "curve", "bid_ask", "mixed"];
export const SOL_BUFFER = 0.08;
export const MAX_TRADE_POSITIONS = 10;

// Auto flip awal trade baru: default /settings, hanya untuk shape yang bisa di-flip.
// (FLIP_SHAPES tidak di-import: flip-trade.js sudah meng-import modul ini.)
const AUTO_FLIP_SHAPES = ["bid_ask", "mixed"];
function autoFlipForNewTrade(shape) {
  const pct = getSettings().autoFlipPct;
  return pct != null && AUTO_FLIP_SHAPES.includes(shape) ? { pct } : null;
}

const fmt = (n) => Number(n).toFixed(4);

function withDeps(deps = {}) {
  return {
    loadSdk: () => import("@meteora-ag/dlmm"),
    getConnection,
    getWallet,
    getPoolInfo,
    getMintDecimals,
    getTokenBalance,
    guardPoolPrice,
    swapSolToToken,
    swapToSol,
    buildFeePlan,
    checkFeeCap,
    sendAndConfirmRobust,
    ...deps,
  };
}

async function checkBalance(d, depositSol, extraRentSol) {
  const balance = (await d.getConnection().getBalance(d.getWallet().publicKey)) / 1e9;
  const need = depositSol + SOL_BUFFER + extraRentSol;
  if (balance >= need) return null;
  return `Not enough SOL: need ${fmt(need)}, have ${fmt(balance)} (short ${fmt(need - balance)})`;
}

// Bin aktif + rem harga pool vs pasar (pola executeEntry). Rem mati -> baca bin aktif saja.
async function readActiveBin(d, pool, info, { attempts, delayMs = 0, onRetry } = {}) {
  if (!config.entry.poolPriceCheck) return { activeBin: await pool.getActiveBin(), guard: null, exhausted: false };
  return d.guardPoolPrice({
    getActiveBin: () => pool.getActiveBin(),
    baseMint: info.baseMint,
    baseIsX: info.baseIsX,
    thresholdPct: config.entry.maxPoolPriceDeviationPct,
    attempts,
    delayMs,
    onRetry,
    onUnavailable: (guard) => log.warn(`Open ${info.pairName || "?"}: ${guard.reason} — lanjut tanpa cek deviasi`),
  });
}

// Rencana open (tanpa efek samping: hanya baca pool, harga, saldo).
export async function planOpen({ poolAddress, depositSol, below, above, shape, deps } = {}) {
  const d = withDeps(deps);
  if (!SHAPES.includes(shape)) return { error: `unknown shape: ${shape}` };
  if (!(depositSol > 0)) return { error: "deposit must be greater than 0" };

  const sdk = await d.loadSdk();
  const info = await d.getPoolInfo(poolAddress);
  if (info.unsupported || !info.baseMint) return { error: "unsupported pool: not a SOL pair" };
  const { pool, baseMint, baseIsX } = info;
  const binStep = pool.lbPair.binStep;

  const { activeBin, guard } = await readActiveBin(d, pool, info, { attempts: 1 });
  const activeId = activeBin.binId;
  const { lowerBin, upperBin, binCount, solOnly } = pctToBinRange({
    activeBin: activeId,
    binStep,
    below,
    above,
    baseIsX,
  });

  // Jumlah posisi = yang benar-benar dibuat: <= 70 bin satu posisi, lebih lebar per potongan multi2.
  const ranges = positionRanges(sdk, pool, lowerBin, upperBin);
  const positionCount = ranges.length;
  if (positionCount > MAX_TRADE_POSITIONS) {
    return { error: `range too wide: ${positionCount} positions (max ${MAX_TRADE_POSITIONS})` };
  }

  // Rent tumbuh dengan lebar posisi: semua rent di atas satu posisi standar 70 bin ikut dicek
  // (buffer 0.08 SOL menutup posisi standar itu).
  const connection = d.getConnection();
  const rentOf = (bins) => sdk.getPositionRentExemption(connection, new BN(bins));
  const [standardRent, ...rents] = await Promise.all([
    rentOf(sdk.DEFAULT_BIN_PER_POSITION.toNumber()),
    ...ranges.map((r) => rentOf(r.upperBin - r.lowerBin + 1)),
  ]);
  const rentSol = rents.reduce((s, r) => s + r, 0) / 1e9;
  const extraRentSol = Math.max(0, rentSol - standardRent / 1e9);

  const balanceError = await checkBalance(d, depositSol, extraRentSol);
  if (balanceError) return { error: balanceError };

  const price = Number(activeBin.price);
  let parts = null;
  try {
    parts = splitParts({
      sdk,
      shape,
      solOnly,
      depositSol,
      activeBin: activeId,
      binStep,
      lowerBin,
      upperBin,
      baseIsX,
      price,
    });
  } catch (err) {
    // Auto-fill SDK bisa gagal pada harga ekstrem (Decimal -> notasi eksponen -> BN).
    log.warn(`planOpen ${poolAddress.slice(0, 8)}: auto-fill gagal: ${err.message}`);
  }
  if (!parts) return { error: "could not compute the token/SOL split for this range" };

  const decimals = await d.getMintDecimals(baseMint);
  const { lowSol, highSol } = binPriceBounds({
    lowerBin,
    upperBin,
    binStep,
    baseIsX,
    decimalsBase: decimals,
    decimalsSol: 9,
  });

  return {
    poolAddress,
    pair: info.pairName || `${baseMint.slice(0, 4)}-SOL`,
    baseMint,
    baseIsX,
    activeBin: activeId,
    binStep,
    lowerBin,
    upperBin,
    binCount,
    positionCount,
    shape,
    depositSol,
    solSideSol: parts.reduce((s, p) => s + p.solSideSol, 0),
    swapSol: parts.reduce((s, p) => s + p.swapSol, 0),
    rentSol,
    extraRentSol,
    lowSol,
    highSol,
    priceGuard: guard
      ? { ok: guard.ok, unavailable: !!guard.unavailable, deviationPct: guard.deviationPct ?? null }
      : null,
    below,
    above,
    solOnly,
    decimals,
    parts,
  };
}

// Rentang tiap posisi on-chain, sama dengan yang dibuat executeOpen (single <= 70 bin, selain itu multi2).
function positionRanges(sdk, pool, lowerBin, upperBin) {
  const binCount = upperBin - lowerBin + 1;
  const width = binCount <= sdk.DEFAULT_BIN_PER_POSITION.toNumber() ? binCount : parallelWidth(sdk, pool);
  return chunkRange(lowerBin, upperBin, width);
}

// Swap balik token yang dibeli tapi tidak masuk posisi: saldo di atas saldo sebelum swap,
// maks. sebanyak yang dibeli (token milik user yang sudah ada tidak ikut dijual).
async function revertUnused(d, baseMint, boughtUi, tokenBefore) {
  if (!(boughtUi > 0)) return null;
  try {
    const amount = Math.min(boughtUi, Math.max(0, (await d.getTokenBalance(baseMint)) - tokenBefore));
    if (!(amount > 0)) return null;
    const res = await d.swapToSol(baseMint, amount);
    if (res.success) log.info(`Open: ${amount} ${baseMint.slice(0, 8)} tak terpakai dikembalikan ke SOL`);
    else log.error(`Open: revert ${amount} ${baseMint.slice(0, 8)} → SOL gagal: ${res.error}`);
    return { amount, success: !!res.success };
  } catch (err) {
    log.error(`Open: revert ${baseMint.slice(0, 8)} → SOL error: ${err.message}`);
    return { amount: null, success: false };
  }
}

function revertNote(r) {
  if (!r) return "";
  if (r.success) return ` Unused tokens (${fmt(r.amount)}) were swapped back to SOL.`;
  return " Swapping the unused tokens back to SOL failed.";
}

// UI -> BN raw lewat BigInt (BN(number) gagal di atas 2^53, mis. 10 juta token 9 desimal).
const rawBN = (ui, decimals) => new BN(BigInt(Math.floor(ui * 10 ** decimals)).toString());

// Jumlah raw X/Y per bagian: token dibagi sebanding porsi swap tiap bagian.
function partAmounts(plan, boughtUi) {
  const tokenRaw = rawBN(boughtUi, plan.decimals);
  return plan.parts.map((p) => {
    const share = plan.swapSol > 0 ? Math.round((p.swapSol / plan.swapSol) * 1e6) : 0;
    const token = tokenRaw.mul(new BN(share)).div(new BN(1e6));
    const sol = rawBN(p.solSideSol, 9);
    return plan.baseIsX ? { x: token, y: sol } : { x: sol, y: token };
  });
}

// Konfirmasi gagal bukan berarti tx tidak mendarat: posisi yang akunnya ada dianggap terbuka.
async function landedLegs(connection, legs) {
  const out = [];
  for (const leg of legs) {
    try {
      if (await connection.getAccountInfo(leg.keypair.publicKey)) out.push(leg);
    } catch {
      // anggap belum mendarat
    }
  }
  return out;
}

export async function executeOpen(plan, { onProgress = () => {}, deps } = {}) {
  const progress = async (text) => {
    try {
      await onProgress(text);
    } catch (err) {
      log.warn(`Open progress update gagal: ${err.message}`);
    }
  };
  if (config.dryRun) {
    await progress("dry run — nothing sent");
    return { success: true, dryRun: true };
  }

  // Token yang sedang dibeli tidak boleh disapu safety sweep; pool tidak boleh dipakai entry bersamaan.
  addEntryInProgressMint(plan.baseMint);
  addEntryInProgressPool(plan.poolAddress);
  try {
    return await openLive(plan, progress, withDeps(deps));
  } catch (err) {
    log.error(`Open ${plan.pair} error: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    removeEntryInProgressMint(plan.baseMint);
    removeEntryInProgressPool(plan.poolAddress);
  }
}

async function openLive(plan, progress, d) {
  const sdk = await d.loadSdk();
  const connection = d.getConnection();
  const wallet = d.getWallet();
  const info = await d.getPoolInfo(plan.poolAddress);
  const { pool } = info;
  const slippage = config.entry.activeBinSlippagePct;

  await progress("Checking pool price…");
  const delayMs = Math.max(0, Number(config.entry.poolPriceRetryDelaySec) || 0) * 1000;
  const read = await readActiveBin(d, pool, info, {
    attempts: config.entry.poolPriceMaxAttempts,
    delayMs,
    onRetry: ({ attempt, attempts, deviationPct }) =>
      progress(`Pool price ${deviationPct.toFixed(1)}% off market — retry ${attempt}/${attempts}…`),
  });
  if (read.exhausted) {
    const dev = read.guard.deviationPct.toFixed(1);
    return {
      success: false,
      error: `Pool price is ${dev}% off market after ${read.attempts} tries (limit ${config.entry.maxPoolPriceDeviationPct}%)`,
    };
  }
  // Rencana bisa sudah beberapa menit: geser range mengikuti bin aktif terbaru (jumlah bin tetap).
  const activeId = read.activeBin.binId;
  const shift = activeId - plan.activeBin;
  const lowerBin = plan.lowerBin + shift;
  const upperBin = plan.upperBin + shift;

  const balanceError = await checkBalance(d, plan.depositSol, plan.extraRentSol ?? 0);
  if (balanceError) return { success: false, error: balanceError };

  const feeCap = d.checkFeeCap(d.buildFeePlan());
  if (!feeCap.ok) {
    return { success: false, error: `fee estimate ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL` };
  }
  // Rencana fee baru per tx (tip Jito hanya dipasang sekali per objek rencana). Tx SDK sudah membawa
  // setComputeUnitLimit sendiri, jadi limit dari config tidak ditambahkan (hindari instruksi ganda).
  const txFeePlan = () => ({ ...d.buildFeePlan(), computeUnitLimit: 0 });
  const send = (tx, signers) => d.sendAndConfirmRobust({ connection, tx, signers, feePlan: txFeePlan(), wallet });

  let boughtUi = 0;
  let tokenBefore = 0;
  if (plan.swapSol > 0) {
    tokenBefore = await d.getTokenBalance(plan.baseMint);
    await progress(`Swapping ${fmt(plan.swapSol)} SOL → token…`);
    const swap = await d.swapSolToToken(plan.baseMint, plan.swapSol);
    if (!swap.success) return { success: false, error: `swap failed: ${swap.error}` };
    boughtUi = Number(swap.amountOut) || 0;
    if (boughtUi <= 0) return { success: false, error: "swap produced zero tokens" };
  }

  const maxSingle = sdk.DEFAULT_BIN_PER_POSITION.toNumber();
  const single = plan.binCount <= maxSingle;
  const mainStrategy = {
    minBinId: lowerBin,
    maxBinId: upperBin,
    strategyType: sdk.StrategyType[plan.parts[0].strategy],
  };
  const legs = [];
  let amounts = [];
  let expected = 1;
  let rangesKnown = true;
  let openErr = null;
  // Semua langkah setelah swap ada di dalam try: gagal apa pun -> cek posisi on-chain / revert swap.
  try {
    amounts = partAmounts(plan, boughtUi);
    await pool.refetchStates?.();
    if (single) {
      await progress("Opening position…");
      const keypair = Keypair.generate();
      legs.push({ keypair, lowerBin, upperBin });
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: keypair.publicKey,
        user: wallet.publicKey,
        totalXAmount: amounts[0].x,
        totalYAmount: amounts[0].y,
        strategy: mainStrategy,
        slippage,
      });
      await send(tx, [wallet, keypair]);
    } else {
      await progress("Preparing positions…");
      const res = await pool.initializeMultiplePositionAndAddLiquidityByStrategy2(
        async (n) => Array.from({ length: n }, () => Keypair.generate()),
        amounts[0].x,
        amounts[0].y,
        mainStrategy,
        wallet.publicKey,
        wallet.publicKey,
        slippage
      );
      const items = res.instructionsByPositions;
      const ranges = positionRanges(sdk, pool, lowerBin, upperBin);
      rangesKnown = ranges.length === items.length;
      expected = items.length;
      items.forEach((it, i) => legs.push({ keypair: it.positionKeypair, ...(rangesKnown ? ranges[i] : {}) }));
      const total = items.reduce((s, it) => s + it.transactionInstructions.length, 0);
      let n = 0;
      for (const it of items) {
        for (const ixs of it.transactionInstructions) {
          await progress(`Opening positions… tx ${++n}/${total}`);
          await send(new Transaction().add(...ixs), [wallet, it.positionKeypair]);
        }
      }
    }
  } catch (err) {
    openErr = err;
  }

  let opened = legs;
  let partial = false;
  let warning;
  if (openErr) {
    log.error(`Open ${plan.pair} gagal: ${openErr.message}`);
    opened = await landedLegs(connection, legs);
    if (opened.length === 0) {
      await revertUnused(d, plan.baseMint, boughtUi, tokenBefore);
      return { success: false, error: openErr.message };
    }
    log.warn(`Open ${plan.pair}: ${opened.length}/${expected} posisi ada on-chain — dianggap terbuka`);
    // Multi-posisi: tx yang gagal bisa membuat sebagian likuiditas tidak masuk.
    partial = !single;
  }

  // Catat posisi lalu trade tanpa await di antaranya (loop exit tidak sempat mengadopsi sebagai external).
  const positions = opened.map((l) => l.keypair.publicKey.toString());
  const exit = exitPresetForNewTrade();
  // Mode dari lebar seluruh range (bukan per leg): manual bidask:double bisa ikut DCA bila salah.
  const mode = legMode(plan.binCount, plan.solOnly, config.spotMinBins);
  for (const addr of positions) {
    trackPosition(addr, plan.poolAddress, plan.pair, plan.baseMint, info.collectFeeMode, mode);
  }
  let trade = createTrade({
    pool: plan.poolAddress,
    pair: plan.pair,
    baseMint: plan.baseMint,
    positions,
    shape: plan.shape,
    // activeBin = bin aktif saat buka (dasar % sisi SOL yang dilewati untuk auto flip).
    range: { below: plan.below, above: plan.above, lowerBin, upperBin, activeBin: activeId },
    depositSol: plan.depositSol,
    origin: "manual",
    exit,
    autoFlip: autoFlipForNewTrade(plan.shape),
  });
  if (trade.origin !== "manual") {
    trade = updateTradeMeta(trade.id, { origin: "manual", exit, depositSol: plan.depositSol }) ?? trade;
  }
  log.info(
    `📌 OPEN ${plan.pair} — ${plan.depositSol} SOL ${plan.shape} (${positions.length} posisi) → trade #${trade.id}`
  );

  const mixed = plan.parts.length > 1;
  if (partial) {
    const reverted = await revertUnused(d, plan.baseMint, boughtUi, tokenBefore);
    warning =
      `Open incomplete: ${opened.length} of ${expected} positions on-chain (${openErr.message}).` +
      `${mixed ? " Spot layer skipped." : ""}${revertNote(reverted)}`;
  } else if (mixed && !rangesKnown) {
    const reverted = await revertUnused(d, plan.baseMint, boughtUi, tokenBefore);
    warning = `Spot layer skipped: position ranges unknown — the BidAsk position is open.${revertNote(reverted)}`;
  } else if (mixed) {
    // Mixed: lapisan Spot 30% ke posisi yang sama (per posisi, per potongan <= 70 bin).
    try {
      const pieces = spotPieces({
        legs: opened,
        activeBin: activeId,
        lowerBin,
        upperBin,
        totalX: amounts[1].x,
        totalY: amounts[1].y,
        maxBins: maxSingle,
      });
      for (const [i, piece] of pieces.entries()) {
        await progress(`Adding Spot layer… ${i + 1}/${pieces.length}`);
        const tx = await pool.addLiquidityByStrategy({
          positionPubKey: piece.leg.keypair.publicKey,
          totalXAmount: piece.x,
          totalYAmount: piece.y,
          strategy: { minBinId: piece.lowerBin, maxBinId: piece.upperBin, strategyType: sdk.StrategyType.Spot },
          user: wallet.publicKey,
          slippage,
        });
        await send(tx, [wallet]);
      }
    } catch (err) {
      log.warn(`Open ${plan.pair}: lapisan Spot gagal: ${err.message}`);
      const reverted = await revertUnused(d, plan.baseMint, boughtUi, tokenBefore);
      warning = `Spot layer (30%) failed: ${err.message} — the BidAsk position is open.${revertNote(reverted)}`;
    }
  }

  return { success: true, trade, positions, ...(warning ? { warning } : {}) };
}
