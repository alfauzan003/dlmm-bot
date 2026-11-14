// Sumber data strategi (I/O): daftar pool Meteora, OHLCV (Meteora / GMGN / DexPaprika), info token Jupiter, seri SOL/USD.
// Setiap fungsi menerima deps { fetchJson, sleep, now } agar tes tidak menyentuh jaringan.
import { PublicKey } from "@solana/web3.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { WSOL_MINT, USDC_MINT } from "../core/constants.js";
import { getConnection } from "../solana/connection.js";
import { getPrices } from "../market/jupiter-price.js";
import { fetchGmgnKline } from "../market/gmgn-client.js";
import { fetchDexPaprikaOhlcv } from "../market/dexpaprika.js";
import { toPoolRow, volatilityQueryUrl } from "./screen.js";

const METEORA_BASE = "https://dlmm.datapi.meteora.ag";
const OHLCV_BAR_SEC = 300;
const OHLCV_WINDOW_SEC = 90 * OHLCV_BAR_SEC;
const OHLCV_MIN_RANGE_SEC = 6900;
const TOKEN_BATCH = 100;
const TOKEN_CACHE_MS = 5 * 60 * 1000;
const LP_CACHE_MS = 10 * 60 * 1000;
const POSITION_OWNER_OFFSET = 40; // discriminator 8 + lb_pair 32 (positionOwnerFilter SDK)

const tokenCache = new Map(); // mint -> { at, token }
const lpCache = new Map(); // pool -> { at, count }
let meteoraLastAt = -Infinity; // jam pacing bersama semua request datapi Meteora
let lastSolUsd = null; // harga SOL (USD) baik terakhir dari getSolUsdForced

export function resetMeteoraPace() {
  meteoraLastAt = -Infinity;
}

// Tunggu sampai jarak antar request Meteora >= 60000 / meteoraMaxPerMin ms.
async function paceMeteora(d) {
  const gapMs = 60000 / Math.max(1, Number(config.meteoraMaxPerMin) || 120);
  const wait = meteoraLastAt + gapMs - d.now();
  if (wait > 0) await d.sleep(wait);
  meteoraLastAt = d.now();
}

export async function fetchJson(url, { headers } = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split("?")[0]}`);
  return r.json();
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const num = (v) => (v == null ? NaN : Number(v)); // null jangan jadi 0

function withDeps(deps = {}) {
  return { fetchJson, sleep: sleepMs, now: Date.now, ...deps };
}

export async function fetchPoolRows(url, { deps } = {}) {
  const d = withDeps(deps);
  await paceMeteora(d);
  const json = await d.fetchJson(url);
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.map(toPoolRow).filter(Boolean);
}

// Bar 5m [startSec, endSec], per jendela 90 bar, diberi jeda sesuai batas request Meteora.
export async function fetchOhlcvRange(pool, startSec, endSec, { deps } = {}) {
  const d = withDeps(deps);
  const bars = [];
  for (let s = startSec; s < endSec;) {
    const e = Math.min(s + OHLCV_WINDOW_SEC, endSec);
    const from = e - s < OHLCV_MIN_RANGE_SEC ? e - OHLCV_MIN_RANGE_SEC : s; // jendela terlalu pendek -> mundur
    await paceMeteora(d);
    const json = await d.fetchJson(`${METEORA_BASE}/pools/${pool}/ohlcv?timeframe=5m&start_time=${from}&end_time=${e}`);
    for (const c of Array.isArray(json?.data) ? json.data : []) {
      bars.push({
        time: num(c.timestamp),
        open: num(c.open),
        high: num(c.high),
        low: num(c.low),
        close: num(c.close),
        volume: num(c.volume),
      });
    }
    s = e;
  }
  const seen = new Set();
  return bars
    .sort((a, b) => a.time - b.time)
    .filter((b) => Object.values(b).every(Number.isFinite) && !seen.has(b.time) && seen.add(b.time));
}

// limit + 1 bar 5m terakhir pool (orientasi mentah Meteora: Y per X, bar terakhir bisa masih terbentuk).
// Hanya OHLCV pool Meteora (tanpa fallback GMGN/USD); [] bila gagal.
export async function fetchRecentBars(pool, limit, { deps, now } = {}) {
  const d = withDeps(deps);
  try {
    const nowSec = Math.floor((now ?? d.now()) / 1000);
    const bars = await fetchOhlcvRange(pool, nowSec - (limit + 1) * OHLCV_BAR_SEC, nowSec, { deps });
    return bars.slice(-(limit + 1));
  } catch (err) {
    log.warn(`Meteora OHLCV ${String(pool).slice(0, 8)} gagal: ${err.message}`);
    return [];
  }
}

// Harga SOL (USD) untuk strategi: fetch force (lewati pacing poll Jupiter), fallback harga baik terakhir; null bila belum pernah ada.
export async function getSolUsdForced({ deps } = {}) {
  const get = deps?.getPrices ?? getPrices;
  try {
    const v = Number((await get([WSOL_MINT], { force: true })).get(WSOL_MINT));
    if (v > 0) lastSolUsd = v;
  } catch (err) {
    log.warn(`Harga SOL gagal: ${err.message}`);
  }
  return lastSolUsd;
}

// Volatility pool-discovery (timeframe VOLATILITY_TIMEFRAME) per alamat pool; pool tanpa nilai tidak ada di Map.
export async function fetchVolatility(addresses, { deps } = {}) {
  const d = withDeps(deps);
  const out = new Map();
  if (addresses.length === 0) return out;
  await paceMeteora(d);
  const json = await d.fetchJson(volatilityQueryUrl(addresses));
  for (const p of Array.isArray(json?.data) ? json.data : []) {
    const v = p?.volatility == null ? NaN : Number(p.volatility);
    if (p?.pool_address && Number.isFinite(v)) out.set(p.pool_address, v);
  }
  return out;
}

const RECENT_5M_BARS = 100; // satu request GMGN (maks 100 candle)
const PRICE_FAR = Math.log(2); // seri DexPaprika dianggap salah arah bila close > 2x dari harga acuan
const logDist = (a, b) => Math.abs(Math.log(a / b));

function withCandleDeps(deps = {}) {
  return { fetchGmgnKline, fetchDexPaprikaOhlcv, now: Date.now, ...deps };
}

// DexPaprika (USD): pilih arah seri (base / inversed) yang close terakhirnya dekat harga acuan base token.
async function dexPaprikaUsd(d, pool, opts, refUsd) {
  const bars = await d.fetchDexPaprikaOhlcv(pool, { ...opts, inversed: false });
  if (!(refUsd > 0) || bars.length === 0) return bars;
  if (logDist(bars[bars.length - 1].close, refUsd) <= PRICE_FAR) return bars;
  const inv = await d.fetchDexPaprikaOhlcv(pool, { ...opts, inversed: true });
  if (inv.length && logDist(inv[inv.length - 1].close, refUsd) <= PRICE_FAR) return inv;
  throw new Error("DexPaprika price does not match the token price");
}

// ~100 bar 5m terakhir dalam USD (bar terakhir bisa masih terbentuk): GMGN, fallback DexPaprika.
// Hasil { bars, source, error }; bars [] bila keduanya gagal.
export async function fetchRecent5mUsd(row, { deps } = {}) {
  const d = withCandleDeps(deps);
  let gmgnError = null;
  try {
    const bars = await d.fetchGmgnKline(row.baseMint, { resolution: "5m", limit: RECENT_5M_BARS });
    if (bars?.length) return { bars, source: "gmgn", error: null };
    gmgnError = "no candles";
  } catch (err) {
    gmgnError = err.message;
  }
  try {
    const endSec = Math.floor(d.now() / 1000);
    const bars = await dexPaprikaUsd(
      d,
      row.address,
      { interval: "5m", startSec: endSec - RECENT_5M_BARS * 300, endSec },
      row.basePriceUsd
    );
    if (bars.length) return { bars, source: "dexpaprika", error: null };
    return { bars: [], source: null, error: `GMGN: ${gmgnError} · DexPaprika: no candles` };
  } catch (err) {
    return { bars: [], source: null, error: `GMGN: ${gmgnError} · DexPaprika: ${err.message}` };
  }
}

// Bar 1h DexPaprika (USD) sejak token lahir, dibatasi DEXPAPRIKA_HISTORY_DAYS (0 = tanpa batas).
export async function fetchHistory1hUsd(row, { refUsd, deps } = {}) {
  const d = withCandleDeps(deps);
  const endSec = Math.floor(d.now() / 1000);
  const days = Number(config.autoEntry.dexpaprikaHistoryDays) || 0;
  const born = row.tokenCreatedAt > 0 ? Math.floor(row.tokenCreatedAt / 1000 / 3600) * 3600 : 0;
  const windowStart = days > 0 ? endSec - Math.floor(days * 86400) : 0;
  const startSec = Math.max(born, windowStart);
  if (!(startSec > 0)) throw new Error("token age unknown");
  return dexPaprikaUsd(d, row.address, { interval: "1h", startSec, endSec }, refUsd ?? row.basePriceUsd);
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

// Jumlah LP (owner unik posisi DLMM) di pool; cache 10 menit, null bila RPC gagal (tidak di-cache).
export async function countPoolLps(pool, { deps } = {}) {
  const d = { now: Date.now, getConnection, loadSdk: () => import("@meteora-ag/dlmm"), ...deps };
  const hit = lpCache.get(pool);
  if (hit && d.now() - hit.at < LP_CACHE_MS) return hit.count;
  try {
    const sdk = await d.loadSdk();
    const accounts = await d.getConnection().getProgramAccounts(new PublicKey(sdk.LBCLMM_PROGRAM_IDS["mainnet-beta"]), {
      filters: [sdk.positionV2Filter(), sdk.positionLbPairFilter(new PublicKey(pool))],
      dataSlice: { offset: POSITION_OWNER_OFFSET, length: 32 },
    });
    const owners = new Set(accounts.map((a) => Buffer.from(a.account.data).toString("hex")));
    lpCache.set(pool, { at: d.now(), count: owners.size });
    return owners.size;
  } catch {
    return null;
  }
}

// Pool WSOL/USDC dengan volume 24j terbesar; solIsX menentukan arah harga close.
export async function findSolUsdPoolInfo({ deps } = {}) {
  const d = withDeps(deps);
  await paceMeteora(d);
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
