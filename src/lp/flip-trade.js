// Flip trade bid_ask/mixed: tarik bin yang sudah sepenuhnya token (sisi token dari bin aktif),
// lalu setor ulang token itu sebagai posisi BidAsk satu-sisi (cermin lebar) di atas harga.
// Ping-pong juga membalik arah (side "sol"): SOL dari token leg flip yang sudah terjual ditarik dan
// disetor ulang sebagai BidAsk SOL saja di bawah harga (leg `trade.solLegs`).
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { sleep } from "../core/utils.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { buildFeePlan, checkFeeCap } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getPoolInfo } from "../entry/pool-info.js";
import {
  addEntryInProgressMint,
  removeEntryInProgressMint,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  isEntryInProgressPool,
  isPoolClosing,
} from "../entry/runtime.js";
import { openTokenOnlyPosition } from "../meteora/open-token-position.js";
import { addKeepMint } from "../state/keep-mints.js";
import { getTrackedPosition } from "../state/positions.js";
import { addTradeLeg, getTrade, tryLockTrade, unlockTrade } from "../state/trades.js";
import { MAX_TRADE_POSITIONS, SOL_BUFFER } from "./open-trade.js";

export const FLIP_MAX_BINS = 70;
export const FLIP_SHAPES = ["bid_ask", "mixed"];

export function canFlip(trade) {
  return FLIP_SHAPES.includes(trade?.shape);
}

// Pilih bin yang ditarik: hanya bin sisi token (bin aktif tidak ikut) yang berisi token,
// maksimum `maxBins` terdekat ke bin aktif dari semua leg. Satu rentang per leg.
// side "sol": bin sisi SOL (di bawah harga) yang berisi SOL.
export function selectFlipBins({ legs, activeBinId, baseIsX, maxBins = FLIP_MAX_BINS, side = "token" }) {
  const sol = side === "sol";
  const upper = baseIsX !== sol; // token = X: sisi token di atas bin aktif, sisi SOL di bawah
  const onSide = (binId) => (upper ? binId > activeBinId : binId < activeBinId);
  const picked = [];
  for (const leg of legs || []) {
    for (const b of leg.bins || []) {
      if (onSide(b.binId) && (sol ? b.solAmount : b.tokenAmount) > 0) picked.push({ position: leg.position, binId: b.binId });
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

// Rentang posisi baru: n bin di sisi token (side "sol": sisi SOL), tanpa bin aktif.
export function flipRange(activeBinId, n, baseIsX, side = "token") {
  return baseIsX !== (side === "sol")
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
        solAmount: Number(baseIsX ? b.positionYAmount : b.positionXAmount) || 0,
      })),
    })),
  };
}

// Saldo token (UI) yang melempar error saat RPC gagal: getTokenBalance mengembalikan 0 saat gagal,
// sehingga saldo "sebelum" 0 palsu akan ikut menyetor token yang sudah ada di wallet.
async function readTokenBalance(mint) {
  const connection = getConnection();
  const wallet = getWallet();
  const accounts = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
  if (accounts.value.length === 0) return 0;
  const info = await connection.getTokenAccountBalance(accounts.value[0].pubkey);
  return Number(info.value.uiAmount || 0);
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
    getTokenBalance: readTokenBalance,
    getSolBalance: async () => (await getConnection().getBalance(getWallet().publicKey)) / 1e9,
    feeCheck: () => checkFeeCap(buildFeePlan()),
    openTokenOnlyPosition,
    addKeepMint,
    sleep,
    ...deps,
  };
}

// Rencana flip (tanpa efek samping: baca pool & posisi saja). side "sol" = balik arah ping-pong.
export async function planFlip(trade, { deps, side = "token" } = {}) {
  const d = withDeps(deps);
  if (!canFlip(trade)) return { error: "only bid_ask or mixed trades can be flipped" };
  if ((trade.positions || []).length >= MAX_TRADE_POSITIONS) {
    return { error: `too many positions (${MAX_TRADE_POSITIONS})`, cap: true };
  }
  const { pool, baseIsX } = (await d.loadPool(trade.pool)) || {};
  if (!pool) return { error: "pool not found" };
  const { activeBinId, legs } = await d.readLegs(pool, baseIsX);
  const flipLegs = new Set(trade.flipLegs || []);
  const solLegs = new Set(trade.solLegs || []);
  const own = new Set((trade.positions || []).filter((addr) => getTrackedPosition(addr)?.closed !== true));
  const candidates = legs.filter((l) => own.has(l.position));
  let sel;
  if (side === "sol") {
    // SOL hasil token leg flip yang terjual. Leg asal & leg SOL lama tidak ikut: SOL-nya sudah di bawah harga.
    const tokenLegs = candidates.filter((l) => flipLegs.has(l.position) && !solLegs.has(l.position));
    sel = selectFlipBins({ legs: tokenLegs, activeBinId, baseIsX, side });
    if (sel.binCount === 0) return { binCount: 0 };
  } else {
    // Seluruh sisi token ditata ulang jadi satu posisi: bin baru leg sumber (leg asal / leg SOL ping-pong)
    // + leg flip lama (yang sudah di bawah harga = token lagi). Flip hanya bila leg sumber punya bin baru;
    // leg flip saja = buang fee.
    const isSource = (addr) => !flipLegs.has(addr) || solLegs.has(addr);
    const fresh = selectFlipBins({ legs: candidates.filter((l) => isSource(l.position)), activeBinId, baseIsX });
    if (fresh.binCount === 0) return { binCount: 0 };
    sel = selectFlipBins({ legs: candidates, activeBinId, baseIsX });
    // Cap 70 bisa hanya memilih leg flip (sisa leg sumber lebih jauh) -> tarik-setor tempat yang sama.
    if (!sel.legs.some((l) => isSource(l.position))) return { binCount: 0 };
  }
  // Cek biaya & SOL sebelum menarik apa pun: gagal setelah tarik = token terdampar di wallet.
  const fee = d.feeCheck();
  if (!fee.ok) return { error: `fee estimate ${fee.totalSol.toFixed(6)} SOL > cap ${fee.cap} SOL` };
  const sol = await d.getSolBalance();
  if (!(sol >= SOL_BUFFER)) {
    return { error: `not enough SOL for the new position: need ${SOL_BUFFER}, have ${Number(sol).toFixed(4)}` };
  }
  return {
    binCount: sel.binCount,
    legs: sel.legs,
    newRange: flipRange(activeBinId, sel.binCount, baseIsX, side),
    activeBinId,
    baseIsX,
    pool,
  };
}

// Flip on-chain: tarik bin token, ukur token yang keluar, setor ulang sebagai leg `bidask:token`.
// side "sol": tarik bin SOL token leg flip, ukur SOL yang keluar, setor ulang sebagai leg `bidask:sol`.
export async function flipTrade(trade, { deps, side = "token" } = {}) {
  const d = withDeps(deps);
  const sol = side === "sol";
  const unit = sol ? "SOL" : "token";
  if (!tryLockTrade(trade.id, "flip")) return { success: false, busy: true, binCount: 0 };
  const t = getTrade(trade.id) ?? trade;
  const readBalance = () => (sol ? d.getSolBalance() : d.getTokenBalance(t.baseMint));
  const label = `Flip trade #${t.id} ${t.pair}`;
  // Open/close lain di pool ini mengubah saldo token yang sama -> selisih saldo tidak bisa dipercaya.
  if (isEntryInProgressPool(t.pool) || isPoolClosing(t.pool)) {
    unlockTrade(trade.id);
    return {
      success: false,
      poolBusy: true,
      error: "pool is busy (open/close running) — try again shortly",
      binCount: 0,
    };
  }
  // Token ada di wallet di antara tarik & setor: lindungi dari sweep; pool ditandai supaya
  // posisi baru tidak diadopsi sebagai trade terpisah.
  addEntryInProgressPool(t.pool);
  addEntryInProgressMint(t.baseMint);
  try {
    if (t.closed === true) return { success: false, error: "trade already closed", binCount: 0 };
    // Rencana dibuat ulang di dalam lock: bin aktif bisa bergeser sejak layar konfirmasi.
    const plan = await planFlip(t, { deps, side });
    if (plan.error) return { success: false, error: plan.error, cap: plan.cap === true, binCount: 0 };
    if (plan.binCount === 0) return { success: false, binCount: 0 };
    const { binCount } = plan;
    if (d.dryRun) {
      log.info(`[DRY RUN] ${label}: would flip ${binCount} ${unit} bins → ${JSON.stringify(plan.newRange)}`);
      return { success: true, dryRun: true, binCount };
    }

    let before;
    try {
      before = await readBalance();
    } catch (err) {
      return { success: false, error: `could not read ${unit} balance: ${err?.message ?? err}`, binCount: 0 };
    }
    // Saldo "sesudah" yang gagal dibaca dianggap belum bertambah (dicoba ulang).
    const readAfter = () => Promise.resolve().then(readBalance).catch(() => NaN);
    let failedLegs = 0;
    for (const leg of plan.legs) {
      try {
        await d.removeBins(plan.pool, leg);
      } catch (err) {
        failedLegs++;
        log.warn(`${label}: tarik bin ${leg.position.slice(0, 8)} gagal: ${err?.message ?? err}`);
      }
    }
    let after = await readAfter();
    for (let i = 0; i < BALANCE_RETRIES && !(after > before); i++) {
      await d.sleep(2000);
      after = await readAfter();
    }
    const tokenAmount = after - before;
    if (!(tokenAmount > 0)) {
      if (failedLegs === plan.legs.length) return { success: false, error: "withdraw failed", binCount };
      log.warn(`${label}: saldo ${unit} tidak bertambah setelah tarik — ${unit} disimpan`);
      if (!sol) d.addKeepMint(t.baseMint);
      return { success: false, redepositFailed: true, binCount, tokenAmount: 0 };
    }

    // Rentang dihitung dari bin aktif terbaru (setelah penarikan).
    const activeBinId = await d.readActiveBinId(plan.pool);
    const range = flipRange(activeBinId, binCount, plan.baseIsX, side);
    let res;
    try {
      res = await d.openTokenOnlyPosition({
        poolAddress: t.pool,
        baseMint: t.baseMint,
        tokenAmountUi: tokenAmount,
        ...range,
        distribution: "bid_ask",
        pairName: t.pair,
        side,
      });
    } catch (err) {
      res = { success: false, error: err?.message ?? String(err) };
    }
    if (!res?.success) {
      log.error(`${label}: setor ulang gagal (${res?.error}) — ${tokenAmount} ${unit} disimpan di wallet`);
      if (!sol) d.addKeepMint(t.baseMint);
      return { success: false, redepositFailed: true, binCount, tokenAmount, error: res?.error ?? null };
    }
    addTradeLeg(t.id, res.position, { flip: true, sol });
    log.info(`🔁 ${label}: ${binCount} bin → posisi ${res.position.slice(0, 8)} (${tokenAmount} ${unit})`);
    return { success: true, binCount, tokenAmount, position: res.position };
  } finally {
    removeEntryInProgressPool(t.pool);
    removeEntryInProgressMint(t.baseMint);
    unlockTrade(trade.id);
  }
}
