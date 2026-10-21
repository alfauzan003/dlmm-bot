// Sumber data backtest/strategi (I/O): daftar pool Meteora, OHLCV, info token Jupiter, seri SOL/USD.
// Setiap fungsi menerima deps { fetchJson, sleep, now } agar tes tidak menyentuh jaringan.
import config from "../config/index.js";
import { WSOL_MINT, USDC_MINT } from "../core/constants.js";
import { toPoolRow } from "./screen.js";

const METEORA_BASE = "https://dlmm.datapi.meteora.ag";
const OHLCV_BAR_SEC = 300;
const OHLCV_WINDOW_SEC = 90 * OHLCV_BAR_SEC;
const OHLCV_MIN_RANGE_SEC = 6900;
const TOKEN_BATCH = 100;
const TOKEN_CACHE_MS = 5 * 60 * 1000;

const tokenCache = new Map(); // mint -> { at, token }

export async function fetchJson(url, { headers } = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split("?")[0]}`);
  return r.json();
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withDeps(deps = {}) {
  return { fetchJson, sleep: sleepMs, now: Date.now, ...deps };
}

export async function fetchPoolRows(url, { deps } = {}) {
  const d = withDeps(deps);
  const json = await d.fetchJson(url);
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.map(toPoolRow).filter(Boolean);
}

// Bar 5m [startSec, endSec], per jendela 90 bar, diberi jeda sesuai batas request Meteora.
export async function fetchOhlcvRange(pool, startSec, endSec, { deps } = {}) {
  const d = withDeps(deps);
  const gapMs = 60000 / Math.max(1, Number(config.meteoraMaxPerMin) || 120);
  const bars = [];
  let first = true;
  for (let s = startSec; s < endSec;) {
    const e = Math.min(s + OHLCV_WINDOW_SEC, endSec);
    const from = e - s < OHLCV_MIN_RANGE_SEC ? e - OHLCV_MIN_RANGE_SEC : s; // jendela terlalu pendek -> mundur
    if (!first) await d.sleep(gapMs);
    first = false;
    const json = await d.fetchJson(`${METEORA_BASE}/pools/${pool}/ohlcv?timeframe=5m&start_time=${from}&end_time=${e}`);
    for (const c of Array.isArray(json?.data) ? json.data : []) {
      bars.push({
        time: Number(c.timestamp),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
      });
    }
    s = e;
  }
  const seen = new Set();
  return bars
    .sort((a, b) => a.time - b.time)
    .filter((b) => Number.isFinite(b.time) && !seen.has(b.time) && seen.add(b.time));
}

// Info token Jupiter (organic score, audit, dst) per mint; batch 100, cache 5 menit.
export async function fetchTokens(mints, { deps } = {}) {
  const d = withDeps(deps);
  const now = d.now();
  const out = new Map();
  const need = [];
  for (const m of new Set(mints)) {
    const hit = tokenCache.get(m);
    if (hit && now - hit.at < TOKEN_CACHE_MS) out.set(m, hit.token);
    else need.push(m);
  }
  const key = config.jupiterSwapApiKey || config.jupiterPriceApiKey;
  const base = key ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  const headers = key ? { "x-api-key": key } : undefined;
  for (let i = 0; i < need.length; i += TOKEN_BATCH) {
    const batch = need.slice(i, i + TOKEN_BATCH);
    const json = await d.fetchJson(`${base}/tokens/v2/search?query=${batch.join(",")}`, { headers });
    for (const t of Array.isArray(json) ? json : []) {
      if (!t?.id) continue;
      out.set(t.id, t);
      tokenCache.set(t.id, { at: now, token: t });
    }
  }
  return out;
}

// Pool WSOL/USDC dengan volume 24j terbesar; solIsX menentukan arah harga close.
export async function findSolUsdPoolInfo({ deps } = {}) {
  const d = withDeps(deps);
  const json = await d.fetchJson(`${METEORA_BASE}/pools?page_size=20&sort_by=volume_24h:desc`);
  for (const p of Array.isArray(json?.data) ? json.data : []) {
    const x = p?.token_x?.address;
    const y = p?.token_y?.address;
    if (x === WSOL_MINT && y === USDC_MINT) return { address: p.address, solIsX: true };
    if (x === USDC_MINT && y === WSOL_MINT) return { address: p.address, solIsX: false };
  }
  throw new Error("pool WSOL/USDC tidak ditemukan");
}

export async function findSolUsdPool({ deps } = {}) {
  return (await findSolUsdPoolInfo({ deps })).address;
}

// Close = USDC per SOL bila SOL token X; bila SOL token Y harga dibalik.
export function solUsdSeries(bars, solIsX) {
  return bars.map((b) => [b.time, solIsX ? b.close : 1 / b.close]);
}

// Titik terakhir pada/sebelum waktu itu, kalau belum ada pakai titik pertama.
export function solUsdAtFn(series) {
  return (timeSec) => {
    let lo = 0;
    let hi = series.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid][0] <= timeSec) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return series[ans][1];
  };
}
