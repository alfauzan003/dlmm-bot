// Flip trade bid_ask/mixed: tarik bin yang sudah sepenuhnya token (sisi token dari bin aktif),
// lalu setor ulang token itu sebagai posisi BidAsk satu-sisi (cermin lebar) di atas harga.
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { sleep } from "../core/utils.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { getTokenBalance } from "../solana/balances.js";
import { buildFeePlan } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getPoolInfo } from "../entry/pool-info.js";
import {
  addEntryInProgressMint,
  removeEntryInProgressMint,
  addEntryInProgressPool,
  removeEntryInProgressPool,
} from "../entry/runtime.js";
import { openTokenOnlyPosition } from "../meteora/open-token-position.js";
import { addKeepMint } from "../state/keep-mints.js";
import { getTrackedPosition } from "../state/positions.js";
import { addTradeLeg, getTrade, tryLockTrade, unlockTrade } from "../state/trades.js";
import { MAX_TRADE_POSITIONS } from "./open-trade.js";

export const FLIP_MAX_BINS = 70;
export const FLIP_SHAPES = ["bid_ask", "mixed"];

export function canFlip(trade) {
  return FLIP_SHAPES.includes(trade?.shape);
}

// Pilih bin yang ditarik: hanya bin sisi token (bin aktif tidak ikut) yang berisi token,
// maksimum `maxBins` terdekat ke bin aktif dari semua leg. Satu rentang per leg.
export function selectFlipBins({ legs, activeBinId, baseIsX, maxBins = FLIP_MAX_BINS }) {
  const tokenSide = (binId) => (baseIsX ? binId > activeBinId : binId < activeBinId);
  const picked = [];
  for (const leg of legs || []) {
    for (const b of leg.bins || []) {
      if (tokenSide(b.binId) && b.tokenAmount > 0) picked.push({ position: leg.position, binId: b.binId });
    }
  }
  picked.sort((a, b) => Math.abs(a.binId - activeBinId) - Math.abs(b.binId - activeBinId));
  const chosen = picked.slice(0, maxBins);

  const byLeg = new Map();
  for (const { position, binId } of chosen) {
    const r = byLeg.get(position);
    if (!r) byLeg.set(position, { position, fromBinId: binId, toBinId: binId });
    else {
      r.fromBinId = Math.min(r.fromBinId, binId);
      r.toBinId = Math.max(r.toBinId, binId);
    }
  }
  // Urutan leg mengikuti input.
  const out = (legs || []).map((l) => byLeg.get(l.position)).filter(Boolean);
  return { binCount: chosen.length, legs: out };
}

// Rentang posisi baru: n bin di sisi token, tanpa bin aktif.
export function flipRange(activeBinId, n, baseIsX) {
  return baseIsX
    ? { minBinId: activeBinId + 1, maxBinId: activeBinId + n }
    : { minBinId: activeBinId - n, maxBinId: activeBinId - 1 };
}

// Berapa kali saldo token dibaca ulang (jeda 2 dtk) bila RPC belum menampilkan hasil penarikan.
const BALANCE_RETRIES = 3;

// Posisi wallet di pool -> bin dengan jumlah token sisi token per bin.
async function readLegs(pool, baseIsX) {
  const { activeBin, userPositions } = await pool.getPositionsByUserAndLbPair(getWallet().publicKey);
  return {
    activeBinId: activeBin.binId,
    legs: (userPositions || []).map((p) => ({
      position: p.publicKey.toString(),
      bins: (p.positionData?.positionBinData || []).map((b) => ({
        binId: b.binId,
        tokenAmount: Number(baseIsX ? b.positionXAmount : b.positionYAmount) || 0,
      })),
    })),
  };
}

// Tarik 100% likuiditas bin [fromBinId, toBinId] satu posisi; posisi & fee tetap.
async function removeBins(pool, { position, fromBinId, toBinId }) {
  const connection = getConnection();
  const wallet = getWallet();
  const res = await pool.removeLiquidity({
    user: wallet.publicKey,
    position: new PublicKey(position),
    fromBinId,
    toBinId,
    bps: new BN(10000),
    shouldClaimAndClose: false,
  });
  const txs = Array.isArray(res) ? res : [res];
  const sigs = [];
  for (const tx of txs) {
    // Fee plan baru per tx: sendAndConfirmRobust mengisi tip Jito ke plan.
    const sent = await sendAndConfirmRobust({ connection, tx, signers: [wallet], feePlan: buildFeePlan(), wallet });
    sigs.push(sent.signature);
  }
  return sigs;
}

function withDeps(deps = {}) {
  return {
    dryRun: config.dryRun,
    loadPool: getPoolInfo,
    readLegs,
    readActiveBinId: async (pool) => (await pool.getActiveBin()).binId,
    removeBins,
    getTokenBalance,
    openTokenOnlyPosition,
    addKeepMint,
    sleep,
    ...deps,
  };
}

// Rencana flip (tanpa efek samping: baca pool & posisi saja).
export async function planFlip(trade, { deps } = {}) {
  const d = withDeps(deps);
  if (!canFlip(trade)) return { error: "only bid_ask or mixed trades can be flipped" };
  if ((trade.positions || []).length >= MAX_TRADE_POSITIONS) {
    return { error: `too many positions (${MAX_TRADE_POSITIONS})` };
  }
  const { pool, baseIsX } = (await d.loadPool(trade.pool)) || {};
  if (!pool) return { error: "pool not found" };
  const { activeBinId, legs } = await d.readLegs(pool, baseIsX);
  const own = new Set((trade.positions || []).filter((addr) => getTrackedPosition(addr)?.closed !== true));
  const sel = selectFlipBins({ legs: legs.filter((l) => own.has(l.position)), activeBinId, baseIsX });
  if (sel.binCount === 0) return { binCount: 0 };
  return {
    binCount: sel.binCount,
    legs: sel.legs,
    newRange: flipRange(activeBinId, sel.binCount, baseIsX),
    activeBinId,
    baseIsX,
    pool,
  };
}

// Flip on-chain: tarik bin token, ukur token yang keluar, setor ulang sebagai leg `bidask:token`.
export async function flipTrade(trade, { deps } = {}) {
  const d = withDeps(deps);
  if (!tryLockTrade(trade.id, "flip")) return { success: false, busy: true, binCount: 0 };
  const t = getTrade(trade.id) ?? trade;
  const label = `Flip trade #${t.id} ${t.pair}`;
  // Token ada di wallet di antara tarik & setor: lindungi dari sweep; pool ditandai supaya
  // posisi baru tidak diadopsi sebagai trade terpisah.
  addEntryInProgressPool(t.pool);
  addEntryInProgressMint(t.baseMint);
  try {
    if (t.closed === true) return { success: false, error: "trade already closed", binCount: 0 };
    // Rencana dibuat ulang di dalam lock: bin aktif bisa bergeser sejak layar konfirmasi.
    const plan = await planFlip(t, { deps });
    if (plan.error) return { success: false, error: plan.error, binCount: 0 };
    if (plan.binCount === 0) return { success: false, binCount: 0 };
    const { binCount } = plan;
    if (d.dryRun) {
      log.info(`[DRY RUN] ${label}: would flip ${binCount} bins → ${JSON.stringify(plan.newRange)}`);
      return { success: true, dryRun: true, binCount };
    }

    const before = await d.getTokenBalance(t.baseMint);
    let failedLegs = 0;
    for (const leg of plan.legs) {
      try {
        await d.removeBins(plan.pool, leg);
      } catch (err) {
        failedLegs++;
        log.warn(`${label}: tarik bin ${leg.position.slice(0, 8)} gagal: ${err?.message ?? err}`);
      }
    }
    let after = await d.getTokenBalance(t.baseMint);
    for (let i = 0; i < BALANCE_RETRIES && !(after > before); i++) {
      await d.sleep(2000);
      after = await d.getTokenBalance(t.baseMint);
    }
    const tokenAmount = after - before;
    if (!(tokenAmount > 0)) {
      if (failedLegs === plan.legs.length) return { success: false, error: "withdraw failed", binCount };
      log.warn(`${label}: saldo token tidak bertambah setelah tarik — token disimpan`);
      d.addKeepMint(t.baseMint);
      return { success: false, redepositFailed: true, binCount, tokenAmount: 0 };
    }

    // Rentang dihitung dari bin aktif terbaru (setelah penarikan).
    const activeBinId = await d.readActiveBinId(plan.pool);
    const range = flipRange(activeBinId, binCount, plan.baseIsX);
    let res;
    try {
      res = await d.openTokenOnlyPosition({
        poolAddress: t.pool,
        baseMint: t.baseMint,
        tokenAmountUi: tokenAmount,
        ...range,
        distribution: "bid_ask",
        pairName: t.pair,
      });
    } catch (err) {
      res = { success: false, error: err?.message ?? String(err) };
    }
    if (!res?.success) {
      log.error(`${label}: setor ulang gagal (${res?.error}) — ${tokenAmount} token disimpan di wallet`);
      d.addKeepMint(t.baseMint);
      return { success: false, redepositFailed: true, binCount, tokenAmount, error: res?.error ?? null };
    }
    addTradeLeg(t.id, res.position, { flip: true });
    log.info(`🔁 ${label}: ${binCount} bin → posisi ${res.position.slice(0, 8)} (${tokenAmount} token)`);
    return { success: true, binCount, tokenAmount, position: res.position };
  } finally {
    removeEntryInProgressPool(t.pool);
    removeEntryInProgressMint(t.baseMint);
    unlockTrade(trade.id);
  }
}
