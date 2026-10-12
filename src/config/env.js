import fs from "fs";
import { ENV_FILE, SETTINGS_FILE, STRAT_FILE } from "../core/paths.js";

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// Override strat dari Telegram (settings.json.stratOverrides): hanya key yang ada di strat.conf,
// nilai string. File rusak / tidak ada = tanpa override. Dibaca langsung (bukan lewat
// state/settings.js) agar config tidak meng-import state.
function readStratOverrides(settingsFile, stratKeys) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"))?.stratOverrides;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (stratKeys.has(key) && typeof value === "string") out[key] = value;
  }
  return out;
}

// .env (rahasia, DRY_RUN) dibaca sekali per proses: reload dari Telegram tidak boleh menerapkan
// editan .env yang menunggu restart.
let bootEnv = null;
function readEnvFile(envFile) {
  if (envFile !== ENV_FILE) return parseEnvFile(envFile);
  if (!bootEnv) bootEnv = parseEnvFile(envFile);
  return bootEnv;
}

// Prioritas: .env < strat.conf (default di-commit, otoritatif atas .env) < override Telegram.
export function loadEnv(stratFile = STRAT_FILE, envFile = ENV_FILE, settingsFile = SETTINGS_FILE) {
  const strat = parseEnvFile(stratFile);
  const overrides = readStratOverrides(settingsFile, new Set(Object.keys(strat)));
  return { ...readEnvFile(envFile), ...strat, ...overrides };
}

export const bool = (val, def = true) => (val == null ? def : val !== "false");

export const num = (val, def) => {
  const n = Number(val);
  return Number.isFinite(n) && val !== "" && val != null ? n : def;
};
