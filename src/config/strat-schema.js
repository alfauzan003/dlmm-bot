// Skema strat.conf untuk editor Telegram: bagian, teks bantuan, tipe, validasi.
// Dibangun dari strat.conf itu sendiri; OVERRIDES hanya untuk yang tidak bisa ditebak.
import fs from "fs";
import { STRAT_FILE } from "../core/paths.js";
import { num } from "./env.js";

const HEADER_RE = /^#\s*={5}\s+([^=].*?)\s+={5}\s*$/;
const KEY_RE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"];

const OVERRIDES = {
  ENTRY_FEE_MODE: { type: "enum", options: ["none", "priority", "jito", "both"] },
  LOG_LEVEL: { type: "enum", options: ["info", "debug"] },
  CANDLE_15M_SOURCE: { type: "enum", options: ["gmgn", "meteora"] },
  TIMEFRAME: { type: "enum", options: TIMEFRAMES },
  VOLUME_TIMEFRAME: { type: "enum", options: TIMEFRAMES },
  ENTRY_TIMEFRAME: { type: "enum", options: TIMEFRAMES },
  ENTRY_TOUCH_MODE: { type: "enum", options: ["held_pullback", "first_touch"] },
  SWEEP_EXCLUDE_MINTS: { type: "list" },
  JITO_TIP_ACCOUNTS: { type: "list" },
  ENTRY_SIZE_SPLIT: { min: 0, max: 1 },
  TRADE_EXIT_INTERVAL_SEC: { min: 1 },
  JUPITER_POLL_INTERVAL_SEC: { min: 1 },
  ENTRY_SCAN_INTERVAL_SEC: { min: 5 },
  ENTRY_TX_RESEND_INTERVAL_MS: { min: 200 },
  ENTRY_TX_RETRY_ATTEMPTS: { min: 1 },
};

// Angka tanpa batas eksplisit: durasi, hitungan, jumlah SOL, bps tidak boleh negatif.
const NON_NEGATIVE_SUFFIXES = [
  "_SEC",
  "_MS",
  "_MINUTES",
  "_DAYS",
  "_HOURS",
  "_COUNT",
  "_ATTEMPTS",
  "_PER_MIN",
  "_RETRY",
  "_MAX",
  "_SOL",
  "_BPS",
];

// Dibaca sekali saat start (src/index.js, setInterval entry, logger, limiter modul-level).
export const RESTART_KEYS = new Set([
  "TRADE_EXIT_INTERVAL_SEC",
  "ENTRY_SCAN_INTERVAL_SEC",
  "JUPITER_POLL_INTERVAL_SEC",
  "LOG_LEVEL",
  "LOG_RETENTION_DAYS",
  "METEORA_MAX_PER_MIN",
  "GMGN_MAX_PER_MIN",
  "GMGN_MIN_GAP_SEC",
]);

export function parseStratText(text) {
  const sections = [{ title: "General", keys: [] }];
  const entries = {};
  let help = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = line.match(HEADER_RE);
    if (header) {
      sections.push({ title: header[1], keys: [] });
      help = [];
      continue;
    }
    if (!line) {
      help = [];
      continue;
    }
    if (line.startsWith("#")) {
      help.push(line.replace(/^#\s?/, ""));
      continue;
    }
    const kv = line.match(KEY_RE);
    if (kv) {
      const [, key, value] = kv;
      const section = sections.length - 1;
      sections[section].keys.push(key);
      entries[key] = { key, default: value.trim(), help: help.join("\n"), section };
    }
    help = [];
  }
  if (sections[0].keys.length === 0) sections.shift();
  // Indeks bagian mengikuti daftar akhir (setelah "General" kosong dibuang).
  sections.forEach((s, i) => s.keys.forEach((k) => (entries[k].section = i)));
  return { sections, entries };
}

export function loadStratSchema(file = STRAT_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { sections: [], entries: {} };
  }
  return parseStratText(text);
}

export function typeOf(key, def) {
  const o = OVERRIDES[key] || {};
  if (o.type === "enum") return { type: "enum", options: o.options };
  if (o.type === "list") return { type: "list" };
  const d = String(def ?? "").trim();
  if (d === "true" || d === "false") return { type: "bool" };
  if (num(d, null) !== null) {
    const out = { type: "number" };
    const min = o.min ?? (NON_NEGATIVE_SUFFIXES.some((s) => key.endsWith(s)) ? 0 : undefined);
    if (min !== undefined) out.min = min;
    if (o.max !== undefined) out.max = o.max;
    return out;
  }
  return { type: "string" };
}

function rangeText(t) {
  if (t.min !== undefined && t.max !== undefined) return ` between ${t.min} and ${t.max}`;
  if (t.min !== undefined) return ` >= ${t.min}`;
  if (t.max !== undefined) return ` <= ${t.max}`;
  return "";
}

export function validateValue(key, raw, schema) {
  const entry = schema?.entries?.[key];
  if (!entry) return { ok: false, error: `${key} is not in strat.conf` };
  const t = typeOf(key, entry.default);
  const v = String(raw ?? "").trim();
  switch (t.type) {
    case "bool": {
      const b = v.toLowerCase();
      return b === "true" || b === "false"
        ? { ok: true, value: b }
        : { ok: false, error: `${key} must be true or false` };
    }
    case "enum": {
      const hit = t.options.find((opt) => opt.toLowerCase() === v.toLowerCase());
      return hit ? { ok: true, value: hit } : { ok: false, error: `${key} must be one of: ${t.options.join(", ")}` };
    }
    case "list": {
      if (v === "-" || v === "") return { ok: true, value: "" };
      const parts = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return { ok: true, value: parts.join(",") };
    }
    case "number": {
      const error = `${key} must be a number${rangeText(t)}`;
      if (!/^[+-]?\d+(\.\d+)?$/.test(v)) return { ok: false, error };
      const n = Number(v);
      if (!Number.isFinite(n) || (t.min !== undefined && n < t.min) || (t.max !== undefined && n > t.max)) {
        return { ok: false, error };
      }
      return { ok: true, value: String(n) };
    }
    default:
      return v ? { ok: true, value: v } : { ok: false, error: `${key} must not be empty` };
  }
}
