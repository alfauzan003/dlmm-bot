import { readState, writeState } from "./store.js";

// Mint yang pengguna pilih untuk disimpan (Close only / Claim tanpa swap): safety sweep
// tidak menjualnya. Disimpan di state.keepMints (list), dibuat lazy.

export function listKeepMints() {
  const list = readState().keepMints;
  return Array.isArray(list) ? [...list] : [];
}

export function addKeepMint(mint) {
  if (!mint) return;
  const state = readState();
  const list = Array.isArray(state.keepMints) ? state.keepMints : [];
  if (list.includes(mint)) return;
  state.keepMints = [...list, mint];
  writeState(state);
}

export function removeKeepMint(mint) {
  if (!mint) return;
  const state = readState();
  if (!Array.isArray(state.keepMints) || !state.keepMints.includes(mint)) return;
  state.keepMints = state.keepMints.filter((m) => m !== mint);
  writeState(state);
}
