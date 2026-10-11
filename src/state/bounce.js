import { readState, writeState } from "./store.js";

export function armBounceRecovery(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.closed) return;
  p.bounceRecoveryState = "armed";
  p.bounceRecoveryActivePeak = null;
  writeState(state);
}

export function activateBounceRecovery(positionAddress, pnlPct) {
  if (!positionAddress || pnlPct == null) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.closed) return;
  p.bounceRecoveryState = "active";
  p.bounceRecoveryActivePeak = pnlPct;
  writeState(state);
}

export function updateBounceRecoveryPeak(positionAddress, pnlPct) {
  if (!positionAddress || pnlPct == null) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.closed || p.bounceRecoveryState !== "active") return;
  if (p.bounceRecoveryActivePeak == null || pnlPct > p.bounceRecoveryActivePeak) {
    p.bounceRecoveryActivePeak = pnlPct;
    writeState(state);
  }
}

export function getBounceRecoveryState(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || !p.bounceRecoveryState) return null;
  return {
    state: p.bounceRecoveryState,
    activePeak: p.bounceRecoveryActivePeak,
  };
}

export function clearBounceRecovery(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.bounceRecoveryState = null;
  p.bounceRecoveryActivePeak = null;
  writeState(state);
}
