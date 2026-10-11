// Ukur seberapa sering PnL di endpoint Meteora berubah (read-only, tanpa kunci/transaksi).
// Pakai: node scripts/pnl-freshness.js <poolAddress> <walletAddress> [detik=60]
import process from "process";

const [pool, wallet, secArg] = process.argv.slice(2);
if (!pool || !wallet) {
  console.error("Usage: node scripts/pnl-freshness.js <poolAddress> <walletAddress> [seconds=60]");
  process.exit(1);
}
const durationMs = Math.max(5, Number(secArg) || 60) * 1000;
const url = `https://dlmm.datapi.meteora.ag/positions/${pool}/pnl?user=${wallet}&status=open&pageSize=100&page=1`;

const last = new Map(); // posisi -> { value, at }
const gaps = [];
let requests = 0;
let failed = 0;
const latencies = [];
const t0 = Date.now();

while (Date.now() - t0 < durationMs) {
  const started = Date.now();
  try {
    const res = await fetch(url);
    requests++;
    latencies.push(Date.now() - started);
    if (!res.ok) {
      failed++;
      console.log(`${((started - t0) / 1000).toFixed(1)}s  HTTP ${res.status}`);
    } else {
      const data = await res.json();
      for (const e of data.positions || []) {
        const addr = e.positionAddress || "?";
        const value = String(e.pnlUsd);
        const prev = last.get(addr);
        if (!prev || prev.value !== value) {
          if (prev) gaps.push((started - prev.at) / 1000);
          const gap = prev ? ` (+${((started - prev.at) / 1000).toFixed(1)}s)` : "";
          console.log(`${((started - t0) / 1000).toFixed(1)}s  ${addr.slice(0, 8)}  pnlUsd=${value}${gap}`);
          last.set(addr, { value, at: started });
        }
      }
    }
  } catch (err) {
    failed++;
    console.log(`${((started - t0) / 1000).toFixed(1)}s  error: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - started))));
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
console.log("---");
console.log(`requests ${requests}, failed ${failed}, latency avg ${avg(latencies).toFixed(0)}ms`);
console.log(
  gaps.length
    ? `pnlUsd changed ${gaps.length}x, avg gap ${avg(gaps).toFixed(1)}s, min ${Math.min(...gaps).toFixed(1)}s, max ${Math.max(...gaps).toFixed(1)}s`
    : "pnlUsd never changed during the run"
);
