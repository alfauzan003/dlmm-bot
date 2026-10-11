import fs from "fs";
import process from "process";
import { pathToFileURL } from "node:url";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { humanReason } from "../src/core/report.js";
import { collectWalletFlows, reconcilePosition } from "../src/meteora/pnl-reconcile.js";

const BASE = "https://dlmm.datapi.meteora.ag";
const PAGE_SIZE = 50;
const POS_PAGE_SIZE = 100;
const CONCURRENCY = 8;
const COLOR = Boolean(process.stdout.isTTY);
const WIB_MS = 7 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

const ROOT = new URL("..", import.meta.url);

// --- Waktu (semua input & output WIB / UTC+7) ---

export function parseWib(input) {
  const m = String(input)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh || 0), Number(mm || 0)) - WIB_MS;
}

function startOfTodayWib() {
  const w = new Date(Date.now() + WIB_MS);
  return Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - WIB_MS;
}

export function fmtWib(sec) {
  if (!sec) return "-";
  const d = new Date(sec * 1000 + WIB_MS);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(
    2,
    "0"
  )}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function fmtDuration(fromSec, toSec) {
  if (!fromSec || !toSec) return "-";
  let s = Math.max(0, toSec - fromSec);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}h ${h}j`;
  if (h > 0) return `${h}j ${m}m`;
  return `${m}m`;
}

// --- CLI ---

function printHelp() {
  console.log(`PnL report posisi bot (WIB, SOL + USD)

Usage: node scripts/pnl-report.js [opsi]

Opsi:
  --from "YYYY-MM-DD HH:mm"   Mulai (WIB). Default: hari ini 00:00 WIB
  --to   "YYYY-MM-DD HH:mm"   Sampai (WIB). Default: sekarang
  --days N                    Shorthand: N hari terakhir (menimpa --from)
  --wallet <alamat>           Wallet (default: dari .env WALLET_PRIVATE_KEY)
  --verify                    Verifikasi modal posisi dari transaksi on-chain
  --no-verify                 Matikan verifikasi on-chain
  --reconcile-threshold PCT   Ambang beda modal (%) agar dikoreksi (default 25)
  -h, --help                  Tampilkan bantuan

Verifikasi on-chain otomatis aktif bila periode <= 2 hari (mis. --days 1),
kecuali dimatikan dengan --no-verify. Perlu RPC_URL / HELIUS_API_KEY di .env.

Jam boleh dihilangkan ("2026-09-21" = 00:00 WIB).
Contoh:
  node scripts/pnl-report.js --from 2026-09-21
  node scripts/pnl-report.js --from "2026-09-21 08:30" --to "2026-09-21 17:00"
  node scripts/pnl-report.js --days 1
  node scripts/pnl-report.js --days 30 --no-verify`);
}

function parseArgs(argv) {
  const opts = { fromStr: null, toStr: null, days: null, wallet: null, verify: null, thresholdPct: 25 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") opts.fromStr = argv[++i];
    else if (a === "--to") opts.toStr = argv[++i];
    else if (a === "--days" || a === "-d") opts.days = Number(argv[++i]);
    else if (a === "--wallet") opts.wallet = argv[++i];
    else if (a === "--verify") opts.verify = true;
    else if (a === "--no-verify") opts.verify = false;
    else if (a === "--reconcile-threshold") opts.thresholdPct = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Argumen tidak dikenal: ${a}\n`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

function readEnv(key) {
  try {
    const env = fs.readFileSync(new URL(".env", ROOT), "utf8");
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

function walletFromEnv() {
  const raw = readEnv("WALLET_PRIVATE_KEY");
  if (!raw) return null;
  let decoded;
  try {
    decoded = bs58.decode(raw);
  } catch {
    decoded = JSON.parse(raw);
  }
  const kp = Keypair.fromSecretKey(decoded.length === 64 ? decoded : Uint8Array.from(decoded));
  return kp.publicKey.toString();
}

// --- Fetch ---

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
    for (const p of data.pools || []) pools.push(p.poolAddress);
    if (!data.hasNext) break;
    page++;
  }
  return pools;
}

async function getPoolPositions(wallet, pool, status) {
  const positions = [];
  let page = 1;
  for (;;) {
    const url = `${BASE}/positions/${pool}/pnl?user=${wallet}&status=${status}&pageSize=${POS_PAGE_SIZE}&page=${page}`;
    const data = await fetchJson(url);
    for (const p of data.positions || []) positions.push({ ...p, pool, tokenX: data.tokenX, tokenY: data.tokenY });
    if (!data.hasNext) break;
    page++;
  }
  return positions;
}

// --- Format ---

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtSol(v) {
  const n = num(v);
  return n == null ? "-" : n.toFixed(5);
}

function fmtUsd(v) {
  const n = num(v);
  return n == null ? "-" : n.toFixed(2);
}

function fmtPct(v) {
  const n = num(v);
  if (n == null) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function pairCell(sol, usd) {
  return `${fmtSol(sol)} (${fmtUsd(usd)})`;
}

function shortAddr(a) {
  if (!a) return "-";
  return a.slice(0, 6);
}

function pad(text, width, align = "left") {
  const s = String(text);
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return align === "right" ? fill + s : s + fill;
}

// --- Build rows ---

function loadLocalMeta() {
  const pair = new Map();
  const dca = new Map();
  const reason = new Map();
  const add = (p) => {
    if (!p) return;
    if (p.pool && p.pair) pair.set(p.pool, p.pair);
    if (p.position && p.isDca != null) dca.set(p.position, p.isDca === true);
  };
  try {
    const st = JSON.parse(fs.readFileSync(new URL("state.json", ROOT), "utf8"));
    for (const p of Object.values(st.positions || {})) {
      add(p);
      if (p.position && p.closeReason) reason.set(p.position, p.closeReason);
    }
  } catch {}
  try {
    const dl = JSON.parse(fs.readFileSync(new URL("decision-log.json", ROOT), "utf8"));
    for (const e of dl) {
      add(e);
      if (e.position && e.closeReason && !reason.has(e.position)) reason.set(e.position, e.closeReason);
    }
  } catch {}
  return { pair, dca, reason };
}

function seedPools(portfolioPools, meta) {
  const seeds = new Set();
  for (const p of portfolioPools) if (p) seeds.add(p);
  for (const p of meta.pair.keys()) seeds.add(p);
  return [...seeds];
}

function toRow(pos, meta, fromMs, toMs) {
  const createdAt = num(pos.createdAt) || 0;
  const createdMs = createdAt * 1000;
  if (createdMs < fromMs || createdMs > toMs) return null;

  const closedAt = num(pos.closedAt) || 0;
  const isOpen = pos.isClosed !== true && !closedAt;
  const depos = pos.allTimeDeposits?.total || {};
  const withd = pos.allTimeWithdrawals?.total || {};
  const fees = pos.allTimeFees?.total || {};

  const pnlSol = num(pos.pnlSol) ?? 0;
  const pnlUsd = num(pos.pnlUsd) ?? 0;

  return {
    _createdAt: createdAt,
    _pos: pos,
    open: fmtWib(createdAt),
    close: isOpen ? "-" : fmtWib(closedAt),
    dur: fmtDuration(createdAt, isOpen ? Math.floor(Date.now() / 1000) : closedAt),
    status: isOpen ? "OPEN" : "CLOSED",
    isOpen,
    pool: meta.pair.get(pos.pool) || `${shortAddr(pos.tokenX)}-${shortAddr(pos.tokenY)}`,
    poolAddr: pos.pool,
    pos: shortAddr(pos.positionAddress),
    dca: meta.dca.get(pos.positionAddress) ? "DCA" : "",
    dep: pairCell(depos.sol, depos.usd),
    wd: pairCell(withd.sol, withd.usd),
    fee: pairCell(fees.sol, fees.usd),
    pnlSol,
    pnlUsd,
    pnl: pairCell(pos.pnlSol, pos.pnlUsd),
    pnlPct: fmtPct(pos.pnlSolPctChange),
    reason: isOpen ? "masih terbuka" : humanReason(meta.reason.get(pos.positionAddress) || ""),
    note: "",
    corrected: false,
    verified: true,
    apiDepSol: num(depos.sol) ?? 0,
    apiPnlSol: pnlSol,
    apiPnlUsd: pnlUsd,
  };
}

// Terapkan hasil verifikasi on-chain ke satu baris tabel.
function applyReconcile(row, rec) {
  row.corrected = rec.corrected;
  row.verified = rec.verified;
  row.apiPnlSol = row.pnlSol;
  row.apiPnlUsd = row.pnlUsd;
  if (rec.corrected) {
    row.dep = pairCell(rec.depositSol, rec.depositUsd);
    row.pnlSol = rec.pnlSol;
    row.pnlUsd = rec.pnlUsd;
    row.pnl = pairCell(rec.pnlSol, rec.pnlUsd);
    row.pnlPct = rec.depositSol > 0 ? fmtPct((rec.pnlSol / rec.depositSol) * 100) : "-";
    row.note = "⚠ koreksi";
  } else if (!rec.verified) {
    row.note = "? tak terverifikasi";
  } else {
    row.note = "ok";
  }
  row.rec = rec;
}

// --- Print ---

const COLS = [
  { key: "no", header: "#", align: "right" },
  { key: "open", header: "BUKA (WIB)", align: "left" },
  { key: "close", header: "TUTUP (WIB)", align: "left" },
  { key: "dur", header: "DUR", align: "right" },
  { key: "status", header: "STATUS", align: "left" },
  { key: "pool", header: "POOL", align: "left" },
  { key: "pos", header: "POSISI", align: "left" },
  { key: "dca", header: "DCA", align: "left" },
  { key: "dep", header: "DEPOSIT SOL ($)", align: "right" },
  { key: "wd", header: "WITHDRAW SOL ($)", align: "right" },
  { key: "fee", header: "FEE SOL ($)", align: "right" },
  { key: "pnl", header: "PNL SOL ($)", align: "right" },
  { key: "pnlPct", header: "PNL %", align: "right" },
  { key: "note", header: "VERIF", align: "left" },
];

function printTable(rows) {
  const cols = rows.some((r) => r.note) ? COLS : COLS.filter((c) => c.key !== "note");
  const widths = cols.map((c) => Math.max(c.header.length, ...rows.map((r) => String(r[c.key]).length)));
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i], cols[i].align)).join("  ");
  console.log(line(cols.map((c) => c.header)));
  console.log(widths.map((w) => "─".repeat(w)).join("──"));
  for (const row of rows) {
    const cells = cols.map((c) => row[c.key]);
    const colored = cells.map((cell, i) => {
      const key = cols[i].key;
      if (COLOR && key === "pnl") {
        if (row.pnlSol < 0) return `\x1b[31m${pad(cell, widths[i], cols[i].align)}\x1b[0m`;
        if (row.pnlSol > 0) return `\x1b[32m${pad(cell, widths[i], cols[i].align)}\x1b[0m`;
      }
      if (COLOR && key === "pnlPct") {
        const p = parseFloat(row.pnlPct);
        if (Number.isFinite(p) && p < 0) return `\x1b[31m${pad(cell, widths[i], cols[i].align)}\x1b[0m`;
        if (Number.isFinite(p) && p > 0) return `\x1b[32m${pad(cell, widths[i], cols[i].align)}\x1b[0m`;
      }
      return pad(cell, widths[i], cols[i].align);
    });
    console.log(colored.join("  "));
  }
}

function sum(rows, key) {
  return rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
}

function printPerPool(rows) {
  const order = [];
  const byPool = new Map();
  for (const r of rows) {
    if (!byPool.has(r.poolAddr)) {
      byPool.set(r.poolAddr, []);
      order.push(r.poolAddr);
    }
    byPool.get(r.poolAddr).push(r);
  }

  console.log("\n▸ PER POOL (urut waktu, tiap posisi terpisah)");
  for (const addr of order) {
    const list = byPool.get(addr);
    const closed = list.filter((r) => !r.isOpen);
    const open = list.filter((r) => r.isOpen);
    const label = list[0].pool;
    const counts = [`${closed.length} closed`, ...(open.length ? [`${open.length} open`] : [])];
    console.log(`\n  ${label}  [${counts.join(", ")}]  ${addr}`);
    list.forEach((r, i) => {
      const tag = r.isOpen ? "OPEN" : "CLOSE";
      const dca = r.dca ? " (DCA)" : "";
      const note = r.note && r.note !== "ok" ? `  [${r.note}]` : "";
      console.log(
        `    ${i + 1}. ${r.open} → ${r.close}  ${tag}${dca}  ${r.pos}  PNL ${r.pnl}  ${r.pnlPct}  ${r.reason}${note}`
      );
    });
    const parts = [];
    if (closed.length)
      parts.push(`closed: ${signed(sum(closed, "pnlSol"), fmtSol)} SOL (${signed(sum(closed, "pnlUsd"), fmtUsd)}$)`);
    if (open.length)
      parts.push(`open: ${signed(sum(open, "pnlSol"), fmtSol)} SOL (${signed(sum(open, "pnlUsd"), fmtUsd)}$)`);
    console.log(`    Subtotal ${parts.join("  |  ")}`);
  }
}

function signed(v, fmt) {
  return `${v >= 0 ? "+" : ""}${fmt(v)}`;
}

function printSummary(rows, fromMs, toMs) {
  const closed = rows.filter((r) => !r.isOpen);
  const open = rows.filter((r) => r.isOpen);

  const realizedSol = sum(closed, "pnlSol");
  const realizedUsd = sum(closed, "pnlUsd");
  const openSol = sum(open, "pnlSol");
  const openUsd = sum(open, "pnlUsd");
  const wins = closed.filter((r) => r.pnlSol >= 0).length;
  const losses = closed.length - wins;

  const apiRealizedSol = sum(closed, "apiPnlSol");
  const apiRealizedUsd = sum(closed, "apiPnlUsd");
  const corrected = rows.filter((r) => r.corrected).length;
  const unverified = rows.filter((r) => !r.verified).length;
  const anyVerify = rows.some((r) => r.note !== "");

  console.log("\nRINGKASAN");
  console.log(`  Periode       : ${fmtWib(fromMs / 1000)} → ${fmtWib(toMs / 1000)} WIB`);
  console.log(`  Posisi        : ${rows.length} (${closed.length} closed, ${open.length} open)`);
  console.log(`  Realized PnL  : ${signed(realizedSol, fmtSol)} SOL (${signed(realizedUsd, fmtUsd)}$)`);
  if (corrected > 0) {
    console.log(
      `  Meteora (asli): ${signed(apiRealizedSol, fmtSol)} SOL (${signed(apiRealizedUsd, fmtUsd)}$) — dikoreksi ${corrected} posisi`
    );
  }
  console.log(`  Win / Loss    : ${wins} / ${losses}`);
  if (open.length) {
    console.log(
      `  Unrealized    : ${signed(openSol, fmtSol)} SOL (${signed(openUsd, fmtUsd)}$) [${open
        .map((r) => r.pool)
        .join(", ")}]`
    );
    console.log(
      `  Total bila semua ditutup: ${signed(realizedSol + openSol, fmtSol)} SOL (${signed(
        realizedUsd + openUsd,
        fmtUsd
      )}$)`
    );
  }
  if (anyVerify) {
    console.log(`  Verifikasi    : on-chain (⚠ ${corrected} dikoreksi, ? ${unverified} tak terverifikasi)`);
  }
  console.log(`  Catatan       : PnL SOL sudah termasuk fee yang dikumpulkan; biaya swap/gas ikut terhitung on-chain.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.days != null && (!Number.isFinite(opts.days) || opts.days <= 0)) {
    console.error("--days harus berupa angka > 0.");
    process.exit(1);
  }
  if (!Number.isFinite(opts.thresholdPct) || opts.thresholdPct < 0) {
    console.error("--reconcile-threshold harus berupa angka >= 0.");
    process.exit(1);
  }

  let fromMs;
  let toMs;
  if (opts.days != null) {
    toMs = Date.now();
    fromMs = toMs - opts.days * 86400 * 1000;
  } else {
    fromMs = opts.fromStr ? parseWib(opts.fromStr) : startOfTodayWib();
    toMs = opts.toStr ? parseWib(opts.toStr) : Date.now();
  }

  if (fromMs == null) {
    console.error(`--from tidak valid: "${opts.fromStr}" (contoh: 2026-09-21 atau "2026-09-21 08:30")`);
    process.exit(1);
  }
  if (toMs == null) {
    console.error(`--to tidak valid: "${opts.toStr}" (contoh: 2026-09-21 atau "2026-09-21 17:00")`);
    process.exit(1);
  }
  if (fromMs > toMs) {
    console.error("--from tidak boleh lebih akhir dari --to.");
    process.exit(1);
  }

  const wallet = opts.wallet || walletFromEnv();
  if (!wallet) {
    console.error("Wallet tidak diketahui. Isi WALLET_PRIVATE_KEY di .env atau pakai --wallet <alamat>.");
    process.exit(1);
  }

  const meta = loadLocalMeta();

  process.stderr.write(`Mengumpulkan daftar pool...\n`);
  let portfolioPools = [];
  try {
    portfolioPools = await getAllPools(wallet);
  } catch (err) {
    process.stderr.write(`  portfolio gagal (${err.message}); lanjut pakai pool dari state.json\n`);
  }
  // ponytail: portfolio API membatasi 100 pool & melewatkan pool yang hanya
  // punya posisi open, jadi seed juga dari state.json/decision-log.
  const pools = seedPools(portfolioPools, meta);
  process.stderr.write(`  ${pools.length} pool dipindai.\n`);

  process.stderr.write(`Mengambil posisi closed + open per pool...\n`);
  let done = 0;
  const all = [];
  await mapLimit(pools, CONCURRENCY, async (pool) => {
    for (const status of ["closed", "open"]) {
      try {
        const list = await getPoolPositions(wallet, pool, status);
        for (const p of list) all.push(p);
      } catch (err) {
        process.stderr.write(`\n  ${shortAddr(pool)} ${status} gagal: ${err.message}\n`);
      }
    }
    done++;
    process.stderr.write(`\r  ${done}/${pools.length} pool selesai`);
  });
  process.stderr.write("\n");

  const seen = new Set();
  const rows = [];
  for (const pos of all) {
    if (!pos.positionAddress || seen.has(pos.positionAddress)) continue;
    const row = toRow(pos, meta, fromMs, toMs);
    if (!row) continue;
    seen.add(pos.positionAddress);
    rows.push(row);
  }

  const verify = opts.verify == null ? toMs - fromMs <= 2 * 86400 * 1000 : opts.verify;
  if (verify && rows.length) {
    const rpcUrl = rpcFromEnv();
    process.stderr.write(`Verifikasi modal on-chain (ambang ${opts.thresholdPct}%)...\n`);
    try {
      const flows = await collectWalletFlows(wallet, fromMs - 5 * 60 * 1000, toMs, { rpcUrl });
      let corrected = 0;
      let unverified = 0;
      for (const row of rows) {
        const rec = reconcilePosition(row._pos, flows, { thresholdPct: opts.thresholdPct });
        applyReconcile(row, rec);
        if (rec.corrected) corrected++;
        else if (!rec.verified) unverified++;
      }
      process.stderr.write(`  ${flows.length} tx dicek; ${corrected} dikoreksi, ${unverified} tak terverifikasi.\n`);
    } catch (err) {
      process.stderr.write(`  verifikasi gagal (${err.message}); pakai angka Meteora.\n`);
      for (const row of rows) applyReconcile(row, { corrected: false, verified: false, reason: err.message });
    }
  }

  rows.sort((a, b) => a._createdAt - b._createdAt);
  rows.forEach((r, i) => (r.no = i + 1));

  console.log("");
  console.log(`PnL REPORT — ${wallet}`);
  console.log(`Periode ${fmtWib(fromMs / 1000)} → ${fmtWib(toMs / 1000)} WIB  |  ${rows.length} posisi`);
  console.log("");
  if (!rows.length) {
    console.log("Tidak ada posisi pada periode ini.");
    return;
  }
  printTable(rows);
  printPerPool(rows);
  printSummary(rows, fromMs, toMs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Gagal: ${err.message}`);
    process.exit(1);
  });
}
