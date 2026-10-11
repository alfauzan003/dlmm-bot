import fs from "fs";
import path from "path";
import config from "../config/index.js";
import log from "../core/logger.js";
import { ROOT } from "../core/paths.js";
import { fetchCandles } from "./candles.js";
import { computeSupertrend } from "./supertrend.js";

const BAR_SEC = 900;
const SCHEMA = 2;

// Path cache dibaca lazily agar test bisa mengarahkannya ke file sementara.
function cacheFile() {
  return process.env.SUPERTREND_CACHE_FILE || path.resolve(ROOT, config.supertrendCacheFile);
}

// mint -> { direction, line, closedBar, updatedAt }
const state = new Map();
// mint -> barStart saat fetch sukses terakhir (mencegah >1 fetch per bar)
const fetchedBar = new Map();
const inflight = new Set();
let loaded = false;

function currentBarStart(now = Date.now()) {
  return Math.floor(now / 1000 / BAR_SEC) * BAR_SEC;
}

// Bar candle terakhir yang sudah tutup.
function latestClosedBarStart(now = Date.now()) {
  return currentBarStart(now) - BAR_SEC;
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    if (raw?.schema !== SCHEMA) return; // format lama / nilai basi dibuang
    for (const [mint, s] of Object.entries(raw?.state || {})) {
      if (s && Number.isFinite(s.line) && s.direction && Number.isFinite(s.closedBar)) state.set(mint, s);
    }
    if (state.size) log.debug(`[detail] Supertrend cache dimuat: ${state.size} mint dari disk`);
  } catch {
    // belum ada file cache — abaikan
  }
}

function save() {
  try {
    const obj = { schema: SCHEMA, savedAt: Date.now(), state: Object.fromEntries(state) };
    fs.writeFileSync(cacheFile(), JSON.stringify(obj));
  } catch (err) {
    log.warn(`saveSupertrendCache: ${err.message}`);
  }
}

// Kembalikan state hanya jika berlaku untuk bar terakhir yang sudah tutup
// (garis dihitung dari candle final bar tersebut) dan belum basi.
export function getSupertrend(mint, now = Date.now()) {
  if (!mint) return null;
  load();
  const s = state.get(mint);
  if (!s) return null;
  if (s.closedBar !== latestClosedBarStart(now)) return null;
  const ageMin = (now - (s.updatedAt || 0)) / 60000;
  if (ageMin > config.gmgnMaxStaleMin) return null;
  return s;
}

// Fallback: garis satu bar sebelumnya, dipakai singkat saat garis bar terbaru
// belum selesai dihitung (transisi bar) agar evaluasi entry tidak terlewat.
export function getSupertrendFallback(mint, now = Date.now()) {
  if (!mint) return null;
  load();
  const s = state.get(mint);
  if (!s) return null;
  const expected = latestClosedBarStart(now);
  if (!Number.isFinite(s.closedBar) || s.closedBar < expected - BAR_SEC) return null;
  const ageMin = (now - (s.updatedAt || 0)) / 60000;
  if (ageMin > config.gmgnMaxStaleMin) return null;
  return s;
}

export function getSupertrendAny(mint) {
  load();
  return state.get(mint) || null;
}

// Hitung Supertrend dari candle 15m yang sudah TUTUP saja. Menolak data yang
// belum memuat bar terakhir yang tutup, supaya garis tidak dihitung dari bar
// lama / candle parsial.
export function supertrendFromClosed(candles, period, mult, now = Date.now()) {
  if (!candles || candles.length < period + 2) return null;
  const cur = currentBarStart(now);
  const closed = candles.filter((c) => Math.floor(c.time / BAR_SEC) * BAR_SEC < cur);
  if (closed.length < period + 2) return null;
  const lastClosed = Math.floor(closed[closed.length - 1].time / BAR_SEC) * BAR_SEC;
  if (lastClosed !== cur - BAR_SEC) return null;
  return computeSupertrend(closed, period, mult);
}

export async function refreshSupertrend(mint, { force = false, now = Date.now(), deps = {} } = {}) {
  if (!mint) return null;
  const fetchCandlesFn = deps.fetchCandles || fetchCandles;
  const bar = currentBarStart(now);
  if (!force && fetchedBar.get(mint) === bar && getSupertrend(mint, now)) return getSupertrend(mint, now);
  if (inflight.has(mint)) return null;
  inflight.add(mint);
  try {
    const candles = await fetchCandlesFn(mint, null, { resolution: "15m", limit: 90, allowStale: false });
    if (!candles || candles.length < config.entry.stAtrPeriod + 2) return null;
    const st = supertrendFromClosed(candles, config.entry.stAtrPeriod, config.entry.stMultiplier, now);
    if (!st) return null;
    const prev = state.get(mint);
    const s = { direction: st.direction, line: st.line, closedBar: latestClosedBarStart(now), updatedAt: now };
    state.set(mint, s);
    fetchedBar.set(mint, bar);
    save();
    const changed = !prev || prev.line !== s.line || prev.direction !== s.direction;
    const msg = `Supertrend ${mint.slice(0, 8)}: ${st.direction} line ${st.line} (closed bar ${new Date(s.closedBar * 1000)
      .toISOString()
      .slice(11, 16)} UTC)`;
    if (changed) log.info(msg);
    else log.debug(`[detail] ${msg}`);
    return s;
  } catch (err) {
    log.warn(`refreshSupertrend ${mint.slice(0, 8)}: ${err.message}`);
    return null;
  } finally {
    inflight.delete(mint);
  }
}

// Picu penyegaran di latar belakang. Retry per bar (fetchedBar dihitung per
// bar), jadi state yang sempat dihitung dari data stale tidak terkunci.
export function ensureSupertrend(mint, deps = {}) {
  if (!mint) return;
  const bar = currentBarStart();
  if (fetchedBar.get(mint) === bar && getSupertrend(mint)) return;
  if (inflight.has(mint)) return;
  refreshSupertrend(mint, { deps }).catch(() => {});
}

export function clearSupertrendCache() {
  state.clear();
  fetchedBar.clear();
  save();
}
