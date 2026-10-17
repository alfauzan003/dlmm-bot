import { readState, writeState } from "./store.js";

// Trade = kumpulan 1..N posisi on-chain dengan TP/SL/Trail sendiri.
// Disimpan di state.trades (key = id string), counter di state.nextTradeId.
// Keduanya dibuat lazy supaya state.json lama tetap jalan.

// Alasan close yang berarti "tidak diketahui" -> pakai fallbackReason.
// `not_detected` = nilai yang ditulis markClosedNotDetected.
const UNKNOWN_REASONS = new Set(["not_detected", "closed_not_detected"]);

function ensureTrades(state) {
  if (!state.trades || typeof state.trades !== "object") state.trades = {};
  if (!Number.isInteger(state.nextTradeId) || state.nextTradeId < 1) state.nextTradeId = 1;
  return state.trades;
}

export function createTrade({
  pool,
  pair,
  baseMint,
  positions,
  shape = null,
  range = null,
  depositSol = null,
  origin,
  exit,
  autoFlip = null,
}) {
  const state = readState();
  const trades = ensureTrades(state);
  // Satu posisi hanya boleh milik satu trade (terbuka atau tertutup): kembalikan trade yang ada,
  // trade terbuka diutamakan. Trade tertutup tidak pernah dibuat ulang (cegah PnL terhitung dobel).
  const owners = Object.values(trades).filter((t) => t && (positions || []).some((addr) => t.positions.includes(addr)));
  const existing = owners.find((t) => t.closed !== true) ?? owners[0];
  if (existing) return existing;
  const id = state.nextTradeId;
  state.nextTradeId = id + 1;
  const trade = {
    id,
    pool,
    pair,
    baseMint,
    positions: [...(positions || [])],
    shape,
    range,
    depositSol,
    depositUsd: null,
    origin,
    exit,
    openedAt: Date.now(),
    peakPnlPct: null,
    trailArmed: false,
    closed: false,
    closedAt: null,
    closeReason: null,
    closePnlUsd: null,
    closePnlPct: null,
    closeTx: null,
  };
  // Auto flip { pct }: flip otomatis saat harga melewati pct% sisi SOL range (sekali, lalu mati).
  if (autoFlip) trade.autoFlip = { ...autoFlip };
  trades[String(id)] = trade;
  writeState(state);
  return trade;
}

export function getTrade(id) {
  const state = readState();
  return state.trades?.[String(id)] || null;
}

export function listOpenTrades() {
  const state = readState();
  return Object.values(state.trades || {})
    .filter((t) => t && t.closed !== true)
    .sort((a, b) => a.id - b.id);
}

export function listClosedTrades({ sinceMs = 0, untilMs = Infinity } = {}) {
  const state = readState();
  return Object.values(state.trades || {})
    .filter((t) => t && t.closed === true && t.closedAt >= sinceMs && t.closedAt <= untilMs)
    .sort((a, b) => a.closedAt - b.closedAt);
}

// Hanya trade yang masih terbuka.
export function findTradeByPosition(address) {
  if (!address) return null;
  return listOpenTrades().find((t) => t.positions.includes(address)) || null;
}

// Merge dangkal per key (tp / sl / trail). Mengubah trail me-reset arming.
export function setTradeExit(id, partialExit) {
  const state = readState();
  const t = state.trades?.[String(id)];
  if (!t || !partialExit) return null;
  for (const key of ["tp", "sl", "trail"]) {
    if (partialExit[key]) t.exit[key] = { ...t.exit[key], ...partialExit[key] };
  }
  if (partialExit.trail) {
    t.trailArmed = false;
    t.peakPnlPct = null;
  }
  writeState(state);
  return t;
}

// Ubah metadata trade (origin, exit, depositSol). Exit baru me-reset peak & arming.
export function updateTradeMeta(id, { origin, exit, depositSol } = {}) {
  const state = readState();
  const t = state.trades?.[String(id)];
  if (!t) return null;
  if (origin !== undefined) t.origin = origin;
  if (depositSol !== undefined) t.depositSol = depositSol;
  if (exit !== undefined) {
    t.exit = exit;
    t.trailArmed = false;
    t.peakPnlPct = null;
  }
  writeState(state);
  return t;
}

// Set auto flip trade ({ pct }) atau matikan (null).
export function setTradeAutoFlip(id, autoFlip) {
  const state = readState();
  const t = state.trades?.[String(id)];
  if (!t) return null;
  if (autoFlip) t.autoFlip = { ...autoFlip };
  else delete t.autoFlip;
  writeState(state);
  return t;
}

// Tambah leg ke trade terbuka. `flip` = leg hasil flip (deposit-nya tidak dihitung ulang di PnL).
export function addTradeLeg(id, address, { flip = false } = {}) {
  const state = readState();
  const t = state.trades?.[String(id)];
  if (!t || t.closed === true || !address) return null;
  if (!t.positions.includes(address)) t.positions.push(address);
  if (flip) {
    if (!Array.isArray(t.flipLegs)) t.flipLegs = [];
    if (!t.flipLegs.includes(address)) t.flipLegs.push(address);
  }
  writeState(state);
  return t;
}

// Evil Panda per trade: on/off di exit.panda; progress lama dibuang supaya `armed` lama tidak langsung memicu close.
export function setTradePanda(id, on) {
  const state = readState();
  const t = state.trades?.[String(id)];
  if (!t) return null;
  t.exit = { ...(t.exit || {}), panda: { on: Boolean(on) } };
  delete t.panda;
  writeState(state);
  return t;
}

// Progress Evil Panda: { seenAbove, armed, lastBar }. Tidak ditulis bila Panda mati / trade tertutup.
export function updateTradePanda(id, progress) {
  const state = readState();
  const t = state.trades?.[String(id)];
  if (!t || t.closed === true || t.exit?.panda?.on !== true) return null;
  t.panda = { ...progress };
  writeState(state);
  return t;
}

export function updateTradeProgress(id, { peakPnlPct, trailArmed }) {
  const state = readState();
  const t = state.trades?.[String(id)];
  if (!t) return null;
  if (peakPnlPct !== undefined) t.peakPnlPct = peakPnlPct;
  if (trailArmed !== undefined) t.trailArmed = trailArmed;
  writeState(state);
  return t;
}

export function setTradeDepositUsd(id, usd) {
  const state = readState();
  const t = state.trades?.[String(id)];
  if (!t) return null;
  t.depositUsd = usd;
  writeState(state);
  return t;
}

// Tutup trade bila semua leg-nya sudah closed. Mengembalikan trade yang baru
// diselesaikan, atau null (belum selesai / sudah selesai / tidak ada).
export function settleTradeIfDone(id, { fallbackReason = "closed_outside" } = {}) {
  const state = readState();
  const t = state.trades?.[String(id)];
  if (!t || t.closed === true) return null;

  const legs = t.positions.map((addr) => state.positions[addr]);
  if (legs.length === 0 || legs.some((p) => !p || p.closed !== true)) return null;

  // Leg terakhir = yang paling akhir ditutup (seri -> urutan terakhir).
  let last = legs[0];
  for (const p of legs) if ((p.closedAt ?? 0) >= (last.closedAt ?? 0)) last = p;

  t.closed = true;
  t.closedAt = Math.max(...legs.map((p) => p.closedAt ?? 0));
  t.closeReason = !last.closeReason || UNKNOWN_REASONS.has(last.closeReason) ? fallbackReason : last.closeReason;
  setPnlFromLegs(t, legs);
  t.closeTx = last.closeTx ?? null;
  writeState(state);
  return t;
}

// PnL trade = jumlah PnL USD leg (null bila ada leg tanpa PnL).
function setPnlFromLegs(t, legs) {
  const pnls = legs.map((p) => p?.closePnlUsd);
  const pnlUsd = pnls.some((v) => v == null) ? null : pnls.reduce((s, v) => s + v, 0);
  t.closePnlUsd = pnlUsd;
  t.closePnlPct = pnlUsd != null && t.depositUsd > 0 ? (pnlUsd / t.depositUsd) * 100 : null;
}

// Hitung ulang PnL trade tertutup dari leg (setelah PnL final Meteora masuk).
export function refreshTradePnl(id) {
  const state = readState();
  const t = state.trades?.[String(id)];
  if (!t || t.closed !== true) return null;
  setPnlFromLegs(
    t,
    t.positions.map((addr) => state.positions[addr])
  );
  writeState(state);
  return t;
}

// --- Lock per trade (in-memory saja, tidak pernah ditulis ke disk) ---

const locks = new Map();

export function tryLockTrade(id, kind) {
  const key = String(id);
  if (locks.has(key)) return false;
  locks.set(key, kind);
  return true;
}

export function unlockTrade(id) {
  locks.delete(String(id));
}

export function tradeLock(id) {
  return locks.get(String(id)) ?? null;
}
