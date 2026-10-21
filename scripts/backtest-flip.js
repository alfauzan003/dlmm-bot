// Backtest bid-ask flip. Perintah: fetch (kumpulkan dataset ke BACKTEST_DIR/<profile>/), run (optimizer + laporan).
// Pakai: node scripts/backtest-flip.js fetch --profile <degen|multihour> --days 5 --max-pools 200
//        node scripts/backtest-flip.js run   --profile <degen|multihour> --samples 400 --seed 1
import fs from "fs";
import path from "path";
import config from "../src/config/index.js";
import { BACKTEST_DIR } from "../src/core/paths.js";
import { PROFILES, PROFILE_FIELDS, profileToConf } from "../src/strategy/params.js";
import { optimize, MIN_TRADES } from "../src/strategy/backtest.js";
import {
  fetchPoolRows,
  fetchOhlcvRange,
  fetchTokens,
  findSolUsdPoolInfo,
  solUsdSeries,
  solUsdAtFn,
} from "../src/strategy/sources.js";

const DATAPI_POOLS = "https://dlmm.datapi.meteora.ag/pools";
const MAX_PAGES = 20;
const COVER_SLACK_SEC = 1800;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

function universeUrl(profile, days, nowMs, page) {
  const filter =
    profile === "degen"
      ? `pool_created_at>${nowMs - days * 86400000} && is_blacklisted=false`
      : `tvl>${config.autoEntry.profiles[profile].minTvlUsd} && is_blacklisted=false`;
  return `${DATAPI_POOLS}?page_size=100&page=${page}&sort_by=volume_24h:desc&filter_by=${encodeURIComponent(filter)}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Bar yang sudah ada dianggap cukup bila menutup jendela (pool baru: sejak pool dibuat).
function coversWindow(bars, row, startSec, endSec) {
  if (!Array.isArray(bars) || bars.length === 0) return false;
  const from = Math.max(startSec, Math.floor((row.createdAt || 0) / 1000));
  return bars[0].time <= from + COVER_SLACK_SEC && bars[bars.length - 1].time >= endSec - COVER_SLACK_SEC;
}

async function cmdFetch(args) {
  const profile = args.profile;
  if (!PROFILES.includes(profile)) throw new Error(`--profile harus salah satu: ${PROFILES.join(", ")}`);
  const days = Number(args.days ?? 5);
  const maxPools = Number(args["max-pools"] ?? 200);
  if (!(days > 0) || !(maxPools > 0)) throw new Error("--days dan --max-pools harus > 0");

  const nowMs = Date.now();
  const endSec = Math.floor(nowMs / 1000);
  const startSec = endSec - days * 86400;

  const rows = [];
  for (let page = 1; page <= MAX_PAGES && rows.length < maxPools; page++) {
    for (const r of await fetchPoolRows(universeUrl(profile, days, nowMs, page))) {
      if (!rows.some((x) => x.address === r.address)) rows.push(r);
    }
  }
  rows.length = Math.min(rows.length, maxPools);
  console.log(`[${profile}] ${rows.length} pool SOL, window ${days} hari`);

  const tokens = await fetchTokens(rows.map((r) => r.baseMint));
  const dir = path.join(BACKTEST_DIR, profile);
  fs.mkdirSync(path.join(dir, "bars"), { recursive: true });

  const pools = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const file = path.join(dir, "bars", `${row.address}.json`);
    let bars = readJson(file);
    let note = "cache";
    if (!coversWindow(bars, row, startSec, endSec)) {
      try {
        bars = await fetchOhlcvRange(row.address, startSec, endSec);
        fs.writeFileSync(file, JSON.stringify(bars));
        note = "fetched";
      } catch (err) {
        console.log(`pool ${i + 1}/${rows.length} ${row.name} gagal: ${err.message}`);
        continue;
      }
    }
    console.log(`pool ${i + 1}/${rows.length} ${row.name} ${bars.length} bar (${note})`);
    if (bars.length > 0) pools.push({ row, token: tokens.get(row.baseMint) ?? null });
  }

  const sol = await findSolUsdPoolInfo();
  const solBars = await fetchOhlcvRange(sol.address, startSec, endSec);
  if (solBars.length === 0) throw new Error("No SOL/USD candles — cannot build dataset");
  const dataset = { fetchedAt: nowMs, days, pools, solUsd: solUsdSeries(solBars, sol.solIsX) };
  fs.writeFileSync(path.join(dir, "dataset.json"), JSON.stringify(dataset));
  console.log(
    `dataset: ${pools.length} pool, ${dataset.solUsd.length} titik SOL/USD -> ${path.join(dir, "dataset.json")}`
  );
}

const LIMITS = [
  "5m granularity misses intra-bar chop.",
  "Our real fee share is unknown historically (to be calibrated later).",
  "Dynamic fees are ignored (conservative).",
  "SOL/USD drift inside a trade is ignored.",
  "Survivorship bias: the pool universe is today's pools; token filters (organic score, holders, top holders) use today's snapshot.",
];
const HEADERS = [
  "#", "train score", "train n", "val score", "val n", "win %", "mean %", "median %", "worst10 %",
  "total SOL", "max DD SOL", "avg hold min", "flip %", "top exits", "changed params",
];

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const topExits = (mix) =>
  Object.entries(mix).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}:${n}`).join(" ") || "-";
const changedParams = (p, base) =>
  PROFILE_FIELDS.filter((f) => p[f.field] !== base[f.field]).map((f) => `${f.field}=${p[f.field]}`).join(" ") || "-";

// Metrik (win rate dst.) diambil dari sisi validate = di luar sampel.
function resultRow(r, rank, base) {
  const v = r.validate;
  return [
    rank, fmt(r.train.score), r.train.trades, fmt(v.score), v.trades,
    fmt(v.winRate * 100, 1), fmt(v.meanPct), fmt(v.medianPct), fmt(v.worst10Pct),
    fmt(v.totalSol, 3), fmt(v.maxDrawdownSol, 3), fmt(v.avgHoldMin, 0), fmt(v.flipRate * 100, 0),
    topExits(v.exitMix), changedParams(r.params, base),
  ];
}

function mdTable(rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(HEADERS), line(HEADERS.map(() => "---")), ...rows.map(line)].join("\n");
}

async function cmdRun(args) {
  const profile = args.profile;
  if (!PROFILES.includes(profile)) throw new Error(`--profile harus salah satu: ${PROFILES.join(", ")}`);
  const samples = Math.floor(Number(args.samples ?? 400));
  const seed = Number(args.seed ?? 1);
  if (!(samples > 0) || !Number.isFinite(seed)) throw new Error("--samples harus > 0 dan --seed harus angka");

  const dir = path.join(BACKTEST_DIR, profile);
  const dataset = readJson(path.join(dir, "dataset.json"));
  if (!dataset) throw new Error(`dataset tidak ada di ${dir} — jalankan fetch dulu`);
  const barsByPool = new Map();
  for (const { row } of dataset.pools) {
    const bars = readJson(path.join(dir, "bars", `${row.address}.json`));
    if (Array.isArray(bars) && bars.length > 0) barsByPool.set(row.address, bars);
  }
  const baseP = config.autoEntry.profiles[profile];
  console.log(`[${profile}] ${barsByPool.size} pool, ${samples} sampel, seed ${seed}`);

  const { cutoffSec, results } = optimize({
    dataset,
    barsByPool,
    baseP,
    g: config.autoEntry,
    solUsdAt: solUsdAtFn(dataset.solUsd),
    samples,
    seed,
    minTrades: MIN_TRADES,
  });

  const date = new Date().toISOString().slice(0, 10);
  const reportFile = path.join(dir, `report-${date}.md`);
  const head = [
    `# Backtest report — ${profile} — ${date}`,
    "",
    `Dataset: ${barsByPool.size} pools, ${dataset.days} days, fetched ${new Date(dataset.fetchedAt).toISOString()}. Samples: ${samples}, seed: ${seed}.`,
    cutoffSec == null
      ? ""
      : `Train/validate cutoff: ${new Date(cutoffSec * 1000).toISOString()} (older 70% = train, newest 30% = validate). Metrics columns are from the validate side; ranked by validate score.`,
    "",
  ];
  const limits = ["## Known limits", "", ...LIMITS.map((l) => `- ${l}`), ""];

  if (results.length === 0) {
    const msg = `No parameter set reached ${MIN_TRADES} trades — fetch more pools or days.`;
    console.log(msg);
    fs.writeFileSync(reportFile, [...head, msg, "", ...limits].join("\n"));
    console.log(`report -> ${reportFile}`);
    return;
  }

  const rows = results.map((r, k) => resultRow(r, k + 1, baseP));
  console.log(HEADERS.join(" | "));
  for (const r of rows) console.log(r.join(" | "));
  fs.writeFileSync(reportFile, [...head, "## Top parameter sets", "", mdTable(rows), "", ...limits].join("\n"));
  const bestFile = path.join(dir, "best.conf");
  fs.writeFileSync(bestFile, profileToConf(results[0].params));
  console.log(`report -> ${reportFile}`);
  console.log(`best   -> ${bestFile}`);
  console.log("Not applied — paste best.conf into strat.conf or set the keys in /settings → 🧩 Strategy.");
}

const [cmd] = process.argv.slice(2);
const args = parseArgs(process.argv.slice(3));
if (cmd === "fetch" || cmd === "run") {
  (cmd === "fetch" ? cmdFetch : cmdRun)(args).catch((err) => {
    console.error(`${cmd} gagal: ${err.message}`);
    process.exit(1);
  });
} else {
  console.error(
    "Pakai: node scripts/backtest-flip.js fetch --profile <degen|multihour> --days 5 --max-pools 200\n" +
      "       node scripts/backtest-flip.js run   --profile <degen|multihour> --samples 400 --seed 1"
  );
  process.exit(1);
}
