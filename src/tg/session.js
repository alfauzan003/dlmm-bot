// Penyimpanan sementara in-memory (satu pengguna): wizard, prompt, dan token konfirmasi.
// Semua entri kedaluwarsa setelah TTL_MS (10 menit) kecuali ditentukan lain.
import { randomBytes } from "crypto";

export const TTL_MS = 600000;

const store = new Map(); // key -> { value, expiresAt }

export function put(key, value, ttlMs = TTL_MS) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function take(key) {
  const value = get(key);
  store.delete(key);
  return value;
}

export function del(key) {
  store.delete(key);
}

function sweep() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.expiresAt) store.delete(key);
  }
}

// Token konfirmasi sekali pakai: 8 karakter base36 acak (muat di callback_data "ok:<token>").
export function issueToken(payload, ttlMs = TTL_MS) {
  sweep();
  let token;
  do {
    token = Array.from(randomBytes(8), (b) => (b % 36).toString(36)).join("");
  } while (store.has(`tok:${token}`));
  put(`tok:${token}`, payload, ttlMs);
  return token;
}

export function redeemToken(token) {
  return take(`tok:${token}`);
}
