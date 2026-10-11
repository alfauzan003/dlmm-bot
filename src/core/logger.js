import fs from "fs";
import path from "path";
import { LOG_DIR } from "./paths.js";
import config from "../config/index.js";

const LOG_RETENTION_MS = Math.max(0, Number(config.logRetentionDays) || 0) * 24 * 60 * 60 * 1000;

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Hapus file log harian yang lebih tua dari LOG_RETENTION_DAYS (0 = nonaktif).
function pruneOldLogs() {
  if (LOG_RETENTION_MS <= 0) return;
  const cutoff = Date.now() - LOG_RETENTION_MS;
  let names = [];
  try {
    names = fs.readdirSync(LOG_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^meteorabot-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
    if (!match) continue;
    const fileDate = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (fileDate < cutoff) {
      try {
        fs.unlinkSync(path.join(LOG_DIR, name));
      } catch {
        // silent
      }
    }
  }
}

pruneOldLogs();

function logFile() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return path.join(LOG_DIR, `meteorabot-${y}-${m}-${d}.log`);
}

function format(level, msg) {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] ${msg}`;
}

function write(level, msg) {
  const line = format(level, msg);
  console.log(line);
  try {
    fs.appendFileSync(logFile(), line + "\n");
  } catch {
    // silent
  }
}

const DEBUG_ENABLED = config.logLevel === "debug";

export default {
  info: (msg) => write("INFO", msg),
  warn: (msg) => write("WARN", msg),
  error: (msg) => write("ERROR", msg),
  // Baris teknis ([detail]) — hanya tampil bila LOG_LEVEL=debug.
  debug: (msg) => {
    if (DEBUG_ENABLED) write("DEBUG", msg);
  },
};
