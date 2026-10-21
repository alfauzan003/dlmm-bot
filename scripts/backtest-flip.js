// Backtest bid-ask flip. Perintah: fetch (kumpulkan dataset ke BACKTEST_DIR/<profile>/).
// Pakai: node scripts/backtest-flip.js fetch --profile <degen|multihour> --days 5 --max-pools 200
import fs from "fs";
import path from "path";
import config from "../src/config/index.js";
import { BACKTEST_DIR } from "../src/core/paths.js";
import { PROFILES } from "../src/strategy/params.js";
import {
  fetchPoolRows,
  fetchOhlcvRange,
  fetchTokens,
  findSolUsdPoolInfo,
  solUsdSeries,
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
    rows.push(...(await fetchPoolRows(universeUrl(profile, days, nowMs, page))));
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
  const dataset = { fetchedAt: nowMs, days, pools, solUsd: solUsdSeries(solBars, sol.solIsX) };
  fs.writeFileSync(path.join(dir, "dataset.json"), JSON.stringify(dataset));
  console.log(
    `dataset: ${pools.length} pool, ${dataset.solUsd.length} titik SOL/USD -> ${path.join(dir, "dataset.json")}`
  );
}

const [cmd] = process.argv.slice(2);
const args = parseArgs(process.argv.slice(3));
if (cmd === "fetch") {
  cmdFetch(args).catch((err) => {
    console.error(`fetch gagal: ${err.message}`);
    process.exit(1);
  });
} else {
  console.error("Pakai: node scripts/backtest-flip.js fetch --profile <degen|multihour> --days 5 --max-pools 200");
  process.exit(1);
}
