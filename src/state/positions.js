import fs from "fs";
import { DECISION_LOG_FILE } from "../core/paths.js";
import { LEGACY_MODE } from "../config/rules.js";
import { readState, writeState, readJsonArray } from "./store.js";

export function trackPosition(positionAddress, pool, pair, baseMint, collectFeeMode, mode, isDca = false) {
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
      // Range bin posisi (dicatat sekali saat pertama terlihat; tidak pernah
      // ditulis ulang karena posisi tidak di-resize).
      lowerBin: null,
      upperBin: null,
      binSpan: null,
      isDca: isDca === true,
      lastPnlPeak: null,
      lastPnlLowest: null,
      closed: false,
      closedAt: null,
      closeReason: null,
      closePnlPct: null,
      oorSejak: null,
      oorArah: null,
      // Mulai hitung yield rendah (mode spot): sejak kapan kondisi terpenuhi.
      lowYieldSejak: null,
      trailingActive: false,
      trailingArmedBy: null,
      trailingAnchor: null,
      pendingTrailingPeak: null,
      pendingTrailingCurrent: null,
      pendingTrailingDrop: null,
      pendingTrailingStartedAt: null,
      confirmedTrailingExit: null,
      confirmedTrailingExitUntil: null,
      bounceRecoveryState: null,
      bounceRecoveryActivePeak: null,
      // --- DCA ---
      dcaArmed: false,
      dcaTrough: null,
      dcaArmedAt: null,
      dcaTriggered: false,
      dcaTriggeredAt: null,
      pendingDcaTrough: null,
      pendingDcaCurrent: null,
      pendingDcaStartedAt: null,
      // Safeguard: posisi asli ditandai untuk ikut close setelah DCA terakhir
      // exit karena trailing TP.
      dcaCloseSafeguard: false,
      missedCycles: 0,
      // Berapa kali posisi ini adalah hasil re-entry spot OOR kanan (diwariskan
      // ke posisi berikutnya supaya rantai berhenti di SPOT_REENTRY_MAX).
      spotReentryCount: 0,
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

// Catat range bin sekali saja (lower/upper/span). Tidak menimpa bila sudah ada.
export function recordTrackedRange(positionAddress, lowerBin, upperBin) {
  if (!positionAddress) return;
  const lower = Number(lowerBin);
  const upper = Number(upperBin);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.binSpan != null) return;
  p.lowerBin = lower;
  p.upperBin = upper;
  p.binSpan = upper - lower;
  writeState(state);
}

// --- Counter re-entry spot (OOR kanan) ---

export function getSpotReentryCount(positionAddress) {
  if (!positionAddress) return 0;
  const state = readState();
  return Number(state.positions[positionAddress]?.spotReentryCount) || 0;
}

export function setSpotReentryCount(positionAddress, count) {
  if (!positionAddress) return;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.spotReentryCount = n;
  writeState(state);
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
  if (!p) return;

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
    trailingArmedBy: p.trailingArmedBy,
    trailingAnchor: p.trailingAnchor,
  };

  const decisionLog = readJsonArray(DECISION_LOG_FILE);
  decisionLog.push(entry);
  fs.writeFileSync(DECISION_LOG_FILE, JSON.stringify(decisionLog, null, 2));
}

export function updateOOR(positionAddress, arah) {
  if (!positionAddress || !arah) return;
  const state = readState();
  if (!state.positions[positionAddress]) {
    state.positions[positionAddress] = { position: positionAddress, firstSeenAt: Date.now() };
  }
  const p = state.positions[positionAddress];
  if (!p.oorSejak || p.oorArah !== arah) {
    p.oorSejak = Date.now();
    p.oorArah = arah;
  }
  writeState(state);
}

export function resetOOR(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p) {
    p.oorSejak = null;
    p.oorArah = null;
    writeState(state);
  }
}

export function getOORState(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p?.oorSejak && p?.oorArah) {
    return { sejak: p.oorSejak, arah: p.oorArah };
  }
  return null;
}

// --- Timer yield rendah (mode spot) ---

// Set sekali saat kondisi low-yield pertama terpenuhi (tidak me-reset bila ada).
export function setLowYieldSince(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return null;
  if (p.lowYieldSejak == null) {
    p.lowYieldSejak = Date.now();
    writeState(state);
  }
  return p.lowYieldSejak;
}

export function getLowYieldSince(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  return state.positions[positionAddress]?.lowYieldSejak ?? null;
}

export function clearLowYieldSince(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p && p.lowYieldSejak != null) {
    p.lowYieldSejak = null;
    writeState(state);
  }
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
