import config from "../config/index.js";
import log from "../core/logger.js";

const PRICE_URL = "https://api.jup.ag/price/v3";
const MAX_IDS_PER_REQUEST = 50;
const DEFAULT_BACKOFF_MS = 10_000;

// Pacing + pembatas berbasis header x-ratelimit-*. Loop penjadwal sudah
// membatasi laju; ini mencegah 429 saat kuota API tercapai.
let nextAllowedAt = 0;
let blockedUntil = 0;
let remaining = null; // x-ratelimit-remaining
let resetAt = 0; // x-ratelimit-reset (ms)

function pollGapMs() {
  const intervalSec = Math.max(0.1, Number(config.jupiterPollIntervalSec) || 1);
  return Math.max(100, intervalSec * 1000 * 0.9);
}

function applyRateHeaders(res) {
  const rem = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(rem)) remaining = rem;
  if (Number.isFinite(reset)) resetAt = reset * 1000;
}

function quotaExhausted(now) {
  if (remaining == null) return false;
  if (now >= resetAt) {
    remaining = null;
    return false;
  }
  return remaining <= 0;
}

// Ambil harga USD real-time untuk sekumpulan mint (batch, <=50 mint/request).
// Mengembalikan Map mint -> harga.
export async function getPrices(mints = [], { force = false } = {}) {
  const out = new Map();
  const unique = [...new Set(mints.filter(Boolean))];
  if (unique.length === 0) return out;

  const now = Date.now();
  // force = lewati pacing antar-poll (untuk cek sesekali di jalur entry/DCA),
  // tetap menghormati backoff 429 dan kuota.
  if (now < blockedUntil || quotaExhausted(now)) return out;
  if (!force && now < nextAllowedAt) return out;
  nextAllowedAt = now + pollGapMs();

  const headers = { "Content-Type": "application/json" };
  if (config.jupiterPriceApiKey) headers["x-api-key"] = config.jupiterPriceApiKey;

  for (let i = 0; i < unique.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = unique.slice(i, i + MAX_IDS_PER_REQUEST);
    const url = `${PRICE_URL}?ids=${chunk.join(",")}`;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      applyRateHeaders(res);
      if (res.status === 429) {
        const waitMs = resetAt > Date.now() ? resetAt - Date.now() + 1000 : DEFAULT_BACKOFF_MS;
        blockedUntil = Date.now() + waitMs;
        log.warn(`Jupiter price rate-limited — cooldown ${Math.ceil(waitMs / 1000)}s`);
        continue;
      }
      if (!res.ok) {
        log.warn(`Jupiter price HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const mint of chunk) {
        const entry = data?.[mint];
        const price = Number(entry?.usdPrice ?? entry?.price);
        if (Number.isFinite(price)) out.set(mint, price);
      }
    } catch (err) {
      log.warn(`Jupiter price gagal: ${err.message}`);
    }
  }

  return out;
}

export async function getPrice(mint) {
  if (!mint) return null;
  const prices = await getPrices([mint]);
  return prices.get(mint) ?? null;
}
