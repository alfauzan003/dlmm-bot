import { readState, writeState } from "./store.js";

export function activateTrailing(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.trailingActive = true;
  writeState(state);
}

// Arm trailing dari sinyal indikator (RSI+BB / RSI+MACD).
// trailingAnchor = titik aktivasi (PnL saat sinyal muncul) sebagai referensi trailing.
// - Peak murni yang sudah aktif lebih dulu tidak di-override.
// - Sinyal berulang saat sudah armed tidak me-reset anchor.
export function canArmIndicatorTrailing(tracked) {
  if (!tracked || tracked.closed) return false;
  if (tracked.trailingArmedBy != null) return false;
  if (tracked.trailingActive === true) return false;
  return true;
}

export function armIndicatorTrailing(positionAddress, signalReason, currentPnl) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!canArmIndicatorTrailing(p)) return;
  p.trailingActive = true;
  p.trailingArmedBy = signalReason || "indicator";
  p.trailingAnchor = Number.isFinite(currentPnl) ? currentPnl : null;
  writeState(state);
}

// Naikkan anchor mengikuti PnL pasca-sinyal (trailing mengikuti puncak baru).
export function updateTrailingAnchor(positionAddress, pnlPct) {
  if (!positionAddress || pnlPct == null) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return null;
  if (p.trailingAnchor == null || pnlPct > p.trailingAnchor) {
    p.trailingAnchor = pnlPct;
    writeState(state);
  }
  return p.trailingAnchor;
}

export function queueTrailingDrop(positionAddress, peakPnl, currentPnl) {
  if (!positionAddress || peakPnl == null || currentPnl == null) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.closed) return;

  const drop = peakPnl - currentPnl;
  const changed =
    p.pendingTrailingCurrent == null ||
    currentPnl < p.pendingTrailingCurrent ||
    drop > (p.pendingTrailingDrop ?? -Infinity);

  if (!changed) return;

  p.pendingTrailingPeak = peakPnl;
  p.pendingTrailingCurrent = currentPnl;
  p.pendingTrailingDrop = drop;
  p.pendingTrailingStartedAt = Date.now();
  writeState(state);
}

// Ambang drop trailing = max(reference * ratio, floor).
// Pure: dipakai baik untuk peak-based maupun indicator-armed.
export function trailingDropThreshold(referencePnl, ratioPct, floorPct) {
  const floor = Number.isFinite(Number(floorPct)) ? Number(floorPct) : 0;
  const ratio = Number(ratioPct);
  if (referencePnl == null || !Number.isFinite(ratio) || ratio <= 0 || !(referencePnl > 0)) {
    return floor;
  }
  return Math.max((referencePnl * ratio) / 100, floor);
}

export function resolvePendingTrailingDrop(
  positionAddress,
  currentPnl,
  dropRatioPct,
  dropFloorPct,
  tolerancePct = 1.0
) {
  if (!positionAddress) return { confirmed: false, pending: false };
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.closed || p.pendingTrailingCurrent == null || p.pendingTrailingPeak == null) {
    return { confirmed: false, pending: false };
  }

  const pendingPeak = p.pendingTrailingPeak;
  const pendingCurrent = p.pendingTrailingCurrent;

  p.pendingTrailingPeak = null;
  p.pendingTrailingCurrent = null;
  p.pendingTrailingDrop = null;
  p.pendingTrailingStartedAt = null;

  const threshold = trailingDropThreshold(pendingPeak, dropRatioPct, dropFloorPct);
  const stillNearCrash = currentPnl != null && currentPnl <= pendingCurrent + tolerancePct;
  const stillDroppedEnough = currentPnl != null && pendingPeak - currentPnl >= threshold;

  if (stillNearCrash && stillDroppedEnough) {
    const label = p.trailingArmedBy ? `indicator_trailing(${p.trailingArmedBy})` : "trailing_tp";
    const reason = `${label}: peak ${pendingPeak.toFixed(2)}% -> ${currentPnl.toFixed(2)}%`;
    p.confirmedTrailingExit = reason;
    p.confirmedTrailingExitUntil = Date.now() + 5 * 60 * 1000;
    writeState(state);
    return { confirmed: true, reason };
  }

  writeState(state);
  return { confirmed: false, rejected: true };
}

export function isTrailingConfirmed(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || !p.confirmedTrailingExit || !p.confirmedTrailingExitUntil) return null;
  if (Date.now() > p.confirmedTrailingExitUntil) {
    p.confirmedTrailingExit = null;
    p.confirmedTrailingExitUntil = null;
    writeState(state);
    return null;
  }
  return p.confirmedTrailingExit;
}

export function clearPendingTrailingDrop(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.pendingTrailingPeak = null;
  p.pendingTrailingCurrent = null;
  p.pendingTrailingDrop = null;
  p.pendingTrailingStartedAt = null;
  writeState(state);
}

export function clearTrailingState(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.trailingActive = false;
  p.trailingArmedBy = null;
  p.trailingAnchor = null;
  p.pendingTrailingPeak = null;
  p.pendingTrailingCurrent = null;
  p.pendingTrailingDrop = null;
  p.pendingTrailingStartedAt = null;
  p.confirmedTrailingExit = null;
  p.confirmedTrailingExitUntil = null;
  writeState(state);
}
