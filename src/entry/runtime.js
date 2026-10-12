// Runtime-only state shared between the entry scanner and the exit monitor.

// Set dengan hitungan referensi: add menaikkan, delete menurunkan, entri hilang di 0.
// Auto-entry dan open manual di pool/mint sama tidak saling melepas tanda in-progress.
class RefCountSet extends Set {
  #counts = new Map();

  add(value) {
    this.#counts.set(value, (this.#counts.get(value) || 0) + 1);
    return super.add(value);
  }

  delete(value) {
    const n = this.#counts.get(value) || 0;
    if (n > 1) {
      this.#counts.set(value, n - 1);
      return true;
    }
    this.#counts.delete(value);
    return super.delete(value);
  }

  clear() {
    this.#counts.clear();
    super.clear();
  }
}

// Base mints currently being acquired by an in-flight entry (swap → position).
// Used by the safety sweep so it never sells tokens mid-entry.
const entryInProgressMints = new RefCountSet();
const entryUsage = new Map();
// Pool yang sedang diproses entry/open (cegah dua pembukaan bentrok di pool sama).
const entryInProgressPools = new RefCountSet();
// Pool yang sedang ditutup (cegah flip bertabrakan dengan close/swap).
const closingPools = new Set();

export function getEntryInProgressMints() {
  return entryInProgressMints;
}

export function addEntryInProgressMint(mint) {
  if (mint) entryInProgressMints.add(mint);
}

export function removeEntryInProgressMint(mint) {
  if (mint) entryInProgressMints.delete(mint);
}

export function getEntryInProgressPools() {
  return entryInProgressPools;
}

export function isEntryInProgressPool(pool) {
  return entryInProgressPools.has(pool);
}

export function addEntryInProgressPool(pool) {
  if (pool) entryInProgressPools.add(pool);
}

export function removeEntryInProgressPool(pool) {
  if (pool) entryInProgressPools.delete(pool);
}

export function isPoolClosing(pool) {
  return closingPools.has(pool);
}

export function getClosingPools() {
  return closingPools;
}

export function addClosingPool(pool) {
  if (pool) closingPools.add(pool);
}

export function removeClosingPool(pool) {
  if (pool) closingPools.delete(pool);
}

export function getEntryUsage(pool) {
  return entryUsage.get(pool) || 0;
}

export function incrementEntryUsage(pool) {
  const uses = getEntryUsage(pool) + 1;
  entryUsage.set(pool, uses);
  return uses;
}

// Buffer aksi terakhir (entry/close) untuk baris "AKSI" di ringkasan log.
const recentActions = [];

export function recordAction(text) {
  if (!text) return;
  recentActions.push({ at: Date.now(), text: String(text) });
  if (recentActions.length > 200) recentActions.splice(0, recentActions.length - 200);
}

export function takeRecentActions(sinceMs) {
  const cutoff = Date.now() - Math.max(0, Number(sinceMs) || 0);
  return recentActions.filter((a) => a.at >= cutoff).map((a) => a.text);
}
