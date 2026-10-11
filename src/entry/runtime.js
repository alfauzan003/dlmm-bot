// Runtime-only state shared between the entry scanner and the exit monitor.

// Base mints currently being acquired by an in-flight entry (swap → position).
// Used by the safety sweep so it never sells tokens mid-entry.
const entryInProgressMints = new Set();
const entryUsage = new Map();
// Pool yang sedang diproses entry/DCA (cegah entry & DCA bentrok di pool sama).
const entryInProgressPools = new Set();
// Pool yang sedang ditutup (cegah DCA bertabrakan dengan close/swap).
const closingPools = new Set();
// Backoff per-pool setelah eksekusi DCA gagal.
const dcaCooldownUntil = new Map();

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

export function getDcaCooldownUntil(pool) {
  return dcaCooldownUntil.get(pool) || 0;
}

export function setDcaCooldown(pool, ms) {
  if (pool && ms > 0) dcaCooldownUntil.set(pool, Date.now() + ms);
}

export function getEntryUsage(pool) {
  return entryUsage.get(pool) || 0;
}

export function incrementEntryUsage(pool) {
  const uses = getEntryUsage(pool) + 1;
  entryUsage.set(pool, uses);
  return uses;
}

// Buffer aksi terakhir (entry/DCA/close) untuk baris "AKSI" di ringkasan log.
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
