// Ringkasan strategy-log.jsonl + saran SIM_POOL_DEPTH_FACTOR.
// Pakai: node scripts/strategy-report.js [--profile <name>] [--since <YYYY-MM-DD>]
import process from "process";
import { pathToFileURL } from "node:url";
import { readStrategyLog, summarizeRows } from "../src/strategy/log.js";

const WIB = "+07:00"; // tanggal --since dibaca sebagai awal hari WIB

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
  return out;
}

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-");

function printTable(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, c) => Math.max(...all.map((r) => String(r[c]).length)));
  for (const r of all) console.log(r.map((v, c) => String(v).padEnd(widths[c])).join("  "));
}

function printBuckets(title, list) {
  console.log(`\n${title}`);
  if (list.length === 0) return console.log("  (no data)");
  printTable(["bucket", "trades", "win%", "mean%"], list.map((b) => [b.bucket, b.trades, f1(b.winRate), f1(b.meanPct)]));
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let rows = readStrategyLog();
  if (rows.length === 0) return console.log("No strategy log yet.");
  if (args.profile) rows = rows.filter((r) => r.profile === args.profile);
  if (args.since) {
    const since = Date.parse(`${args.since}T00:00:00${WIB}`);
    if (!Number.isFinite(since)) throw new Error("--since harus berformat YYYY-MM-DD");
    rows = rows.filter((r) => r.ts >= since);
  }
  const s = summarizeRows(rows);
  if (s.groups.length === 0) return console.log("No matching trades.");

  printTable(
    ["mode", "profile", "trades", "win%", "mean%", "median%", "flip%", "hold(min)", "exits"],
    s.groups.map((g) => [
      g.mode,
      g.profile,
      g.trades,
      f1(g.winRate),
      f1(g.meanPct),
      f1(g.medianPct),
      f1(g.flipRate),
      f1(g.avgHoldMin),
      Object.entries(g.exitMix).map(([k, n]) => `${k}:${n}`).join(" "),
    ])
  );
  printBuckets("By rangePct", s.buckets.rangePct);
  printBuckets("By flipPct", s.buckets.flipPct);
  console.log("");
  if (s.calibration) {
    const { factor, mae, n } = s.calibration;
    console.log(`Suggested SIM_POOL_DEPTH_FACTOR=${factor} (MAE ${mae.toFixed(2)}% over ${n} live trades)`);
  } else {
    console.log("No live trades with predictions yet — cannot suggest SIM_POOL_DEPTH_FACTOR.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`Gagal: ${err.message}`);
    process.exit(1);
  }
}
