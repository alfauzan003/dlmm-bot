import fs from "fs";
import { DECISION_LOG_FILE } from "../core/paths.js";
import { LEGACY_MODE } from "../exit/classify.js";
import { readState, writeState, readJsonArray } from "./store.js";

export function trackPosition(positionAddress, pool, pair, baseMint, collectFeeMode, mode) {
  if (!positionAddress) return;
  const state = readState();
  if (!state.positions[positionAddress]) {
    state.positions[positionAddress] = {
      position: positionAddress,
      pool: pool || "",
      pair: pair || "",
      baseMint: baseMint || "",
      firstSeenAt: Date.now(),
      collectFeeMode: collectFeeMode ?? null,
      mode: mode ?? "spot",
      lastPnlPeak: null,
      lastPnlLowest: null,
      closed: false,
      closedAt: null,
      closeReason: null,
      closePnlPct: null,
      missedCycles: 0,
    };
    writeState(state);
  }
}

export function getTrackedPosition(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  return state.positions[positionAddress] || null;
}

export function updateTrackedMode(positionAddress, mode) {
  if (!positionAddress || !mode) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p && p.mode !== mode) {
    p.mode = mode;
    writeState(state);
  }
}

export function updateCollectFeeMode(positionAddress, collectFeeMode) {
  if (!positionAddress || collectFeeMode == null) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p && p.collectFeeMode !== collectFeeMode) {
    p.collectFeeMode = collectFeeMode;
    writeState(state);
  }
}

export function updatePnlPeaks(positionAddress, pnlPct) {
  if (!positionAddress || pnlPct == null) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  if (p.lastPnlPeak == null || pnlPct > p.lastPnlPeak) p.lastPnlPeak = pnlPct;
  if (p.lastPnlLowest == null || pnlPct < p.lastPnlLowest) p.lastPnlLowest = pnlPct;
  writeState(state);
}

export function recordClose(positionAddress, reason, pnlPct, extra = {}) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  // Sudah tertutup: jangan timpa closePnlUsd/closeTx/closedAt (retry atau panggilan ganda).
  if (!p || p.closed) return;

  p.closed = true;
  p.closedAt = Date.now();
  p.closeReason = reason || "";
  p.closePnlPct = pnlPct ?? null;
  p.closePnlUsd = extra.pnlUsd ?? null;
  p.closeTx = extra.closeTx ?? null;
  writeState(state);

  const entry = {
    ts: Date.now(),
    position: positionAddress,
    pool: p.pool,
    pair: p.pair,
    baseMint: p.baseMint,
    ageMinutes: p.firstSeenAt ? Math.floor((Date.now() - p.firstSeenAt) / 60000) : null,
    pnlPct,
    closeReason: reason || "",
    lastPnlPeak: p.lastPnlPeak,
    lastPnlLowest: p.lastPnlLowest,
  };

  const decisionLog = readJsonArray(DECISION_LOG_FILE);
  decisionLog.push(entry);
  fs.writeFileSync(DECISION_LOG_FILE, JSON.stringify(decisionLog, null, 2));
}

// --- Deteksi posisi hilang (ditutup manual) ---

// Semua posisi yang masih dianggap terbuka oleh bot (belum ditutup bot),
// termasuk entri lama yang belum punya field `closed`.
export function getOpenTrackedPositions() {
  const state = readState();
  return Object.values(state.positions).filter((p) => p && p.closed !== true);
}

// Hitung posisi terbuka per pool untuk satu mode (murni, mudah diuji).
// Label mode lama dinormalkan agar `bidask` tetap terhitung sebagai
// `bidask:double`. Mode lain (mis. spot manual) tidak ikut dihitung.
export function countOpenByPoolAndMode(positions, mode) {
  const want = LEGACY_MODE[mode] || mode;
  const counts = new Map();
  for (const p of positions || []) {
    if (!p || p.closed === true || !p.pool) continue;
    if ((LEGACY_MODE[p.mode] || p.mode) !== want) continue;
    counts.set(p.pool, (counts.get(p.pool) || 0) + 1);
  }
  return counts;
}

export function countOpenBotPositionsByPool(mode) {
  return countOpenByPoolAndMode(getOpenTrackedPositions(), mode);
}

export function registerMissedCycle(positionAddress) {
  if (!positionAddress) return 0;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return 0;
  p.missedCycles = (p.missedCycles || 0) + 1;
  writeState(state);
  return p.missedCycles;
}

export function resetMissedCycle(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p && p.missedCycles) {
    p.missedCycles = 0;
    writeState(state);
  }
}

// Tandai posisi sebagai closed karena tidak lagi terbaca on-chain
// (kemungkinan besar ditutup manual di luar bot).
export function markClosedNotDetected(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.closed) return null;
  p.missedCycles = 0;
  writeState(state);
  recordClose(positionAddress, "not_detected", null);
  return getTrackedPosition(positionAddress);
}
