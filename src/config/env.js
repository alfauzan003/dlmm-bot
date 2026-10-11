import fs from "fs";
import { ENV_FILE, STRAT_FILE } from "../core/paths.js";

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

// strat.conf = default strategi (di-commit) MENANG atas .env (rahasia/instance)
// bila key-nya sama, supaya default yang di-commit otoritatif.
export function loadEnv(stratFile = STRAT_FILE, envFile = ENV_FILE) {
  return { ...parseEnvFile(envFile), ...parseEnvFile(stratFile) };
}

export const bool = (val, def = true) => (val == null ? def : val !== "false");

export const num = (val, def) => {
  const n = Number(val);
  return Number.isFinite(n) && val !== "" && val != null ? n : def;
};
