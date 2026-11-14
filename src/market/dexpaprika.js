// DexPaprika: OHLCV pool dalam USD (harga base token; inversed=true = token lawannya).
// Key opsional di header Authorization (nilai key utuh). Tanpa key: hanya interval >= 1h, 24 jam terakhir;
// free key: >= 10m, 7 hari; Dev/Pro (api-pro.dexpaprika.com): semua interval.
import config from "../config/index.js";

const INTERVAL_SEC = { "5m": 300, "10m": 600, "15m": 900, "30m": 1800, "1h": 3600 };
const MAX_LIMIT = 1000;
const MIN_GAP_MS = 2500; // <= 24 req/menit, di bawah batas free key (30/menit)

let lastAt = -Infinity;

export function _resetDexPaprikaForTest() {
  lastAt = -Infinity;
}

async function defaultFetchJson(url, { headers } = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!r.ok) {
    let detail = "";
    try {
      const body = await r.json();
      detail = body?.error ? ` ${body.error}` : "";
    } catch {
      // body bukan JSON
    }
    throw new Error(`DexPaprika HTTP ${r.status}${detail}`);
  }
  return r.json();
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withDeps(deps = {}) {
  return { fetchJson: defaultFetchJson, sleep: sleepMs, now: Date.now, ...deps };
}

async function pace(d) {
  const wait = lastAt + MIN_GAP_MS - d.now();
  if (wait > 0) await d.sleep(wait);
  lastAt = d.now();
}

const toBar = (c) => ({
  time: Math.floor(Date.parse(c?.time_open) / 1000),
  open: Number(c?.open),
  high: Number(c?.high),
  low: Number(c?.low),
  close: Number(c?.close),
  volume: Number(c?.volume),
});

const validBar = (b) => Number.isFinite(b.time) && [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0);

// Bar [startSec, endSec] urut naik, tanpa duplikat; dipaging per 1000 bar.
export async function fetchDexPaprikaOhlcv(pool, { interval, startSec, endSec, inversed = false, deps } = {}) {
  const d = withDeps(deps);
  const step = INTERVAL_SEC[interval];
  if (!step) throw new Error(`DexPaprika: interval ${interval} tidak didukung`);
  const headers = config.dexpaprikaApiKey ? { Authorization: config.dexpaprikaApiKey } : undefined;
  const bars = [];
  for (let s = startSec; s < endSec; s += MAX_LIMIT * step) {
    const q = new URLSearchParams({
      start: String(Math.floor(s)),
      end: String(Math.floor(Math.min(endSec, s + MAX_LIMIT * step))),
      interval,
      limit: String(MAX_LIMIT),
    });
    if (inversed) q.set("inversed", "true");
    await pace(d);
    const json = await d.fetchJson(`${config.dexpaprikaApiUrl}/networks/solana/pools/${pool}/ohlcv?${q}`, { headers });
    for (const c of Array.isArray(json) ? json : []) bars.push(toBar(c));
  }
  const seen = new Set();
  return bars
    .filter(validBar)
    .sort((a, b) => a.time - b.time)
    .filter((b) => !seen.has(b.time) && seen.add(b.time));
}
