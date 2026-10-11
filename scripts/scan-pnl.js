import fs from "fs";
import process from "process";
import { collectWalletFlows, reconcilePosition } from "../src/meteora/pnl-reconcile.js";

const BASE = "https://dlmm.datapi.meteora.ag";
const PAGE_SIZE = 20;
const CONCURRENCY = 8;
const COLOR = Boolean(process.stdout.isTTY);

let WALLET = null;
let DAYS = null;
let VERIFY = null;
let THRESHOLD = 25;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--days" || args[i] === "-d") {
    DAYS = Number(args[++i]);
  } else if (args[i] === "--verify") {
    VERIFY = true;
  } else if (args[i] === "--no-verify") {
    VERIFY = false;
  } else if (args[i] === "--reconcile-threshold") {
    THRESHOLD = Number(args[++i]);
  } else if (!args[i].startsWith("-") && !WALLET) {
    WALLET = args[i];
  }
}

if (!WALLET) {
  console.error(
    "Usage: node scripts/scan-pnl.js <wallet_address> [--days N] [--verify|--no-verify] [--reconcile-threshold PCT]"
  );
  process.exit(1);
}

if (DAYS != null && (!Number.isFinite(DAYS) || DAYS <= 0)) {
  console.error("--days harus berupa angka > 0");
  process.exit(1);
}

if (!Number.isFinite(THRESHOLD) || THRESHOLD < 0) {
  console.error("--reconcile-threshold harus berupa angka >= 0");
  process.exit(1);
}

function readEnv(key) {
  try {
    const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
    const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

function rpcFromEnv() {
  const direct = readEnv("RPC_URL");
  if (direct) return direct;
  const key = readEnv("HELIUS_API_KEY");
  return key ? `https://rpc.helius.xyz/?api-key=${key}` : "https://api.mainnet-beta.solana.com";
}

async function fetchJson(url, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getAllPools(wallet) {
  const pools = [];
  let page = 1;
  for (;;) {
    const url = `${BASE}/positions/portfolio?user=${wallet}&page=${page}&pageSize=${PAGE_SIZE}`;
    const data = await fetchJson(url);
    for (const p of data.pools || []) pools.push(p);
    if (!data.hasNext) break;
    page++;
  }
  return pools;
}

async function getPoolPositions(wallet, pool, status) {
  const positions = [];
  let page = 1;
  for (;;) {
    const url = `${BASE}/positions/${pool}/pnl?user=${wallet}&status=${status}&pageSize=${PAGE_SIZE}&page=${page}`;
    const data = await fetchJson(url);
    for (const p of data.positions || []) positions.push({ ...p, pool, tokenX: data.tokenX, tokenY: data.tokenY });
    if (!data.hasNext) break;
    page++;
  }
  return positions;
}

const wibFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function fmtTime(sec) {
  if (!sec) return "-";
  return wibFmt.format(new Date(sec * 1000)).replace(",", "");
}

function fmtDuration(fromSec, toSec) {
  if (!fromSec || !toSec) return "-";
  let s = Math.max(0, toSec - fromSec);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}j`;
  if (h > 0) return `${h}j ${m}m`;
  return `${m}m`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtSol(v) {
  const n = num(v);
  return n == null ? "-" : n.toFixed(5);
}

function fmtPct(v) {
  const n = num(v);
  if (n == null) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function shortAddr(a) {
  if (!a) return "-";
  return `${a.slice(0, 4)}..${a.slice(-4)}`;
}

function pad(text, width, align = "left") {
  const s = String(text);
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return align === "right" ? fill + s : s + fill;
}

function printTable(rows) {
  const cols = [
    { key: "no", header: "#", align: "right" },
    { key: "open", header: "BUKA (WIB)", align: "left" },
    { key: "close", header: "TUTUP (WIB)", align: "left" },
    { key: "dur", header: "DURASI", align: "right" },
    { key: "pos", header: "POSISI", align: "left" },
    { key: "pair", header: "PAIR", align: "left" },
    { key: "pool", header: "POOL", align: "left" },
    { key: "deposit", header: "DEPOSIT", align: "right" },
    { key: "withdraw", header: "WITHDRAW", align: "right" },
    { key: "fee", header: "FEE", align: "right" },
    { key: "pnl", header: "PNL SOL", align: "right" },
    { key: "pnlPct", header: "PNL %", align: "right" },
  ];
  if (rows.some((r) => r.note)) cols.push({ key: "note", header: "VERIF", align: "left" });

  const widths = cols.map((c) => Math.max(c.header.length, ...rows.map((r) => String(r[c.key]).length)));

  const line = (cells, align, filler = " ") =>
    cells.map((cell, i) => pad(cell, widths[i], align ? cols[i].align : "left")).join(filler);

  console.log(line(cols.map((c) => c.header)));
  console.log(widths.map((w) => "─".repeat(w)).join("─"));

  for (const row of rows) {
    const cells = cols.map((c) => row[c.key]);
    const colored = cells.map((cell, i) => {
      if (COLOR && (cols[i].key === "pnl" || cols[i].key === "pnlPct") && Number(num(row[cols[i].key])) < 0) {
        return `\x1b[31m${pad(cell, widths[i], cols[i].align)}\x1b[0m`;
      }
      return pad(cell, widths[i], cols[i].align);
    });
    console.log(colored.join(" "));
  }
}

function printSummary(rows) {
  let deposit = 0;
  let withdraw = 0;
  let fee = 0;
  let pnl = 0;
  let apiPnl = 0;
  let wins = 0;
  let losses = 0;
  let corrected = 0;

  for (const r of rows) {
    deposit += num(r._depSol) ?? 0;
    withdraw += num(r._wdSol) ?? 0;
    fee += num(r._feeSol) ?? 0;
    pnl += num(r._pnlSol) ?? 0;
    apiPnl += num(r._apiPnlSol) ?? 0;
    if ((num(r._pnlSol) ?? 0) >= 0) wins++;
    else losses++;
    if (r._corrected) corrected++;
  }

  console.log("");
  console.log("RINGKASAN");
  console.log(`  Total posisi   : ${rows.length}`);
  console.log(`  Total deposit  : ${deposit.toFixed(5)} SOL`);
  console.log(`  Total withdraw : ${withdraw.toFixed(5)} SOL`);
  console.log(`  Total fee      : ${fee.toFixed(5)} SOL`);
  console.log(`  Total PnL      : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(5)} SOL`);
  if (corrected > 0) {
    console.log(`  Meteora (asli) : ${apiPnl >= 0 ? "+" : ""}${apiPnl.toFixed(5)} SOL — dikoreksi ${corrected} posisi`);
  }
  console.log(
    `  Win / Loss     : ${wins} / ${losses} (${rows.length ? ((wins / rows.length) * 100).toFixed(1) : "0.0"}% win)`
  );
}

async function main() {
  process.stderr.write(`Scan PnL wallet ${WALLET}\n`);
  process.stderr.write("1/2 Mengumpulkan daftar pool...\n");
  const pools = await getAllPools(WALLET);
  const meta = new Map();
  for (const p of pools) meta.set(p.poolAddress, p);
  process.stderr.write(`    ${pools.length} pool ditemukan.\n`);

  process.stderr.write("2/2 Mengambil posisi per pool...\n");
  let done = 0;
  const perPool = await mapLimit(pools, CONCURRENCY, async (pool) => {
    const list = await getPoolPositions(WALLET, pool.poolAddress, "closed");
    done++;
    process.stderr.write(`\r    ${done}/${pools.length} pool selesai`);
    return { pool, positions: list };
  });
  process.stderr.write("\n");

  const since = DAYS != null ? Math.floor(Date.now() / 1000) - DAYS * 86400 : 0;

  const verify = VERIFY == null ? DAYS != null && DAYS <= 2 : VERIFY;
  let flows = null;
  if (verify) {
    const fromMs = since > 0 ? since * 1000 - 5 * 60 * 1000 : 0;
    process.stderr.write(`Verifikasi modal on-chain (ambang ${THRESHOLD}%)...\n`);
    try {
      flows = await collectWalletFlows(WALLET, fromMs, Date.now(), { rpcUrl: rpcFromEnv() });
      process.stderr.write(`  ${flows.length} tx dicek.\n`);
    } catch (err) {
      process.stderr.write(`  verifikasi gagal (${err.message}); pakai angka Meteora.\n`);
    }
  }

  const rows = [];
  for (const { pool, positions } of perPool) {
    const m = meta.get(pool.poolAddress) || {};
    const pair = `${m.tokenX || "?"}-${m.tokenY || "?"}`;
    for (const pos of positions) {
      if (since && (Number(pos.createdAt) || 0) < since) continue;
      const rec = flows ? reconcilePosition(pos, flows, { thresholdPct: THRESHOLD }) : null;
      const depSol = rec ? rec.depositSol : num(pos.allTimeDeposits?.total?.sol);
      const pnlSol = rec ? rec.pnlSol : num(pos.pnlSol);
      const pnlPct =
        rec && rec.corrected && rec.depositSol > 0 ? (rec.pnlSol / rec.depositSol) * 100 : pos.pnlSolPctChange;
      rows.push({
        _createdAt: Number(pos.createdAt) || 0,
        _depSol: depSol,
        _wdSol: num(pos.allTimeWithdrawals?.total?.sol),
        _feeSol: num(pos.allTimeFees?.total?.sol),
        _pnlSol: pnlSol,
        _apiPnlSol: num(pos.pnlSol),
        _corrected: rec ? rec.corrected : false,
        no: 0,
        open: fmtTime(pos.createdAt),
        close: fmtTime(pos.closedAt),
        dur: fmtDuration(Number(pos.createdAt), Number(pos.closedAt)),
        pos: shortAddr(pos.positionAddress),
        pair,
        pool: shortAddr(pool.poolAddress),
        deposit: fmtSol(depSol),
        withdraw: fmtSol(pos.allTimeWithdrawals?.total?.sol),
        fee: fmtSol(pos.allTimeFees?.total?.sol),
        pnl: fmtSol(pnlSol),
        pnlPct: fmtPct(pnlPct),
        note: rec ? (rec.corrected ? "⚠ koreksi" : rec.verified ? "ok" : "? tak terverifikasi") : "",
      });
    }
  }

  rows.sort((a, b) => a._createdAt - b._createdAt);
  rows.forEach((r, i) => {
    r.no = i + 1;
  });

  console.log("");
  console.log(`PnL PER POSISI — ${WALLET} (SOL, WIB)${DAYS != null ? ` — ${DAYS} hari terakhir` : ""}`);
  console.log("");
  if (!rows.length) {
    console.log(DAYS != null ? `Tidak ada posisi closed dalam ${DAYS} hari terakhir.` : "Tidak ada posisi closed.");
    return;
  }
  printTable(rows);
  printSummary(rows);
}

main().catch((err) => {
  console.error(`Gagal: ${err.message}`);
  process.exit(1);
});
