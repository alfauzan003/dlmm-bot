import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import config from "../config/index.js";
import { ROOT } from "../core/paths.js";
import gmgnLimiter from "./gmgn-limiter.js";

const execFileAsync = promisify(execFile);

const LOCAL_CLI = path.join(ROOT, "node_modules", "gmgn-cli", "dist", "index.js");

function parseResetAt(text) {
  const m = /resets at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(text);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(1000, t - Date.now() + 2000);
}

function firstLine(text) {
  return (
    String(text || "")
      .split("\n")
      .find((l) => l.trim()) || ""
  );
}

function invocation(args) {
  if (fs.existsSync(LOCAL_CLI)) return { cmd: process.execPath, argv: [LOCAL_CLI, ...args] };
  return { cmd: "npx", argv: ["-y", "gmgn-cli@latest", ...args] };
}

async function runGmgnCli(args, { timeoutMs = 30000 } = {}) {
  const { cmd, argv } = invocation(args);
  try {
    const { stdout } = await execFileAsync(cmd, argv, {
      env: { ...process.env, GMGN_API_KEY: config.gmgnApiKey },
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const text = `${err.stdout || ""}\n${err.stderr || ""}\n${err.message || ""}`;
    const wrapped = new Error(firstLine(text) || err.message);
    wrapped.rateLimited = /RATE_LIMIT|HTTP 429|\b429\b|too many requests/i.test(text);
    wrapped.resetAtMs = wrapped.rateLimited ? parseResetAt(text) : null;
    wrapped.raw = text;
    throw wrapped;
  }
}

function parseResolutionSeconds(res) {
  const map = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  return map[res] || 900;
}

// Panggil GMGN lewat limiter bersama (semua jalur GMGN wajib lewat sini).
export async function gmgnRequest(key, args, { timeoutMs = 20000 } = {}) {
  try {
    return await gmgnLimiter.schedule(key, () => runGmgnCli(args, { timeoutMs }));
  } catch (err) {
    if (err.rateLimited) {
      const waitMs = err.resetAtMs ?? 120000;
      gmgnLimiter.blockFor(waitMs);
    }
    throw err;
  }
}

// Ambil kline GMGN untuk satu mint (native 15m). Rate-limit aware.
export async function fetchGmgnKline(mint, { resolution = "15m", limit = 90 } = {}) {
  if (!mint) throw new Error("fetchGmgnKline: mint kosong");
  const resSec = parseResolutionSeconds(resolution);
  const now = Math.floor(Date.now() / 1000);
  const from = now - limit * resSec;
  const args = [
    "market",
    "kline",
    "--chain",
    "sol",
    "--address",
    mint,
    "--resolution",
    resolution,
    "--from",
    String(from),
    "--to",
    String(now),
    "--raw",
  ];

  const stdout = await gmgnRequest(`kline:${mint}:${resolution}`, args, { timeoutMs: 30000 });
  const parsed = JSON.parse(stdout);
  const list = parsed?.list || [];
  return list
    .map((c) => ({
      time: Math.floor(Number(c.time) / 1000),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }))
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close));
}

export { runGmgnCli };
