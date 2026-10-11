import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// src/core -> src -> project root
export const SRC_DIR = path.resolve(__dirname, "..");
export const ROOT = path.resolve(SRC_DIR, "..");

// Path data bisa di-override lewat env (dipakai test agar tidak menyentuh
// file produksi).
function resolveFile(envName, fallbackName) {
  const override = process.env[envName];
  return override && override.trim() ? override : path.join(ROOT, fallbackName);
}

export const ENV_FILE = path.join(ROOT, ".env");
// Default strategi yang di-commit ke git (menang atas .env).
export const STRAT_FILE = resolveFile("STRAT_FILE", "strat.conf");
export const LOG_DIR = path.join(ROOT, "logs");
export const STATE_FILE = resolveFile("STATE_FILE", "state.json");
export const DECISION_LOG_FILE = resolveFile("DECISION_LOG_FILE", "decision-log.json");
export const PNL_HISTORY_FILE = resolveFile("PNL_HISTORY_FILE", "pnl-history.json");
