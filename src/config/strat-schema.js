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
  VOLUME_TIMEFRAME: { type: "enum", options: TIMEFRAMES },
  SWEEP_EXCLUDE_MINTS: { type: "list" },
  JITO_TIP_ACCOUNTS: { type: "list" },
  ENTRY_SIZE_SPLIT: { min: 0, max: 1 },
  TRADE_EXIT_INTERVAL_SEC: { min: 1 },
  JUPITER_POLL_INTERVAL_SEC: { min: 1 },
  ENTRY_SCAN_INTERVAL_SEC: { min: 5 },
  ENTRY_TX_RESEND_INTERVAL_MS: { min: 200 },
  ENTRY_TX_RETRY_ATTEMPTS: { min: 1, int: true },
  POLL_INTERVAL_HOLD: { gt: 0 },
  POLL_INTERVAL_IDLE: { gt: 0 },
  TG_STATUS_INTERVAL: { gt: 0 },
  GAS_RESERVE: { min: 0 },
  GMGN_MAX_STALE_MIN: { min: 1 },
  ST_ATR_PERIOD: { min: 1, int: true },
  ST_MULTIPLIER: { gt: 0 },
  ENTRY_DEFAULT_SIZE_SOL: { gt: 0 },
  POOL_LIST_FILE: { type: "file" },
  SUPERTREND_CACHE_FILE: { type: "file" },
  EVIL_PANDA_SIGNAL_MODE: { type: "enum", options: ["live", "close"] },
  EVIL_PANDA_ST_ATR_PERIOD: { min: 1, int: true },
  EVIL_PANDA_ST_MULTIPLIER: { gt: 0 },
  EVIL_PANDA_RSI_LENGTH: { min: 1, int: true },
  EVIL_PANDA_RSI_LEVEL: { min: 0, max: 100 },
  EVIL_PANDA_MACD_FAST: { min: 1, int: true },
  EVIL_PANDA_MACD_SLOW: { min: 1, int: true },
  EVIL_PANDA_MACD_SIGNAL: { min: 1, int: true },
  EVIL_PANDA_BB_LENGTH: { min: 2, int: true },
  EVIL_PANDA_BB_STDDEV: { gt: 0 },
  DEGEN_ENTRY_TIMING: { type: "enum", options: ["pullback", "immediate"] },
  MULTI_ENTRY_TIMING: { type: "enum", options: ["pullback", "immediate"] },
  DEGEN_RANGE_MODE: { type: "enum", options: ["fixed", "support"] },
  MULTI_RANGE_MODE: { type: "enum", options: ["fixed", "support"] },
  AUTO_SCAN_INTERVAL_SEC: { min: 15 },
  AUTO_ORGANIC_SCORE_MIN: { min: 0, max: 100 },
  AUTO_TOP_HOLDERS_MAX_PCT: { min: 0, max: 100 },
};

// Aturan per pola nama. OVERRIDES menang.
const PATTERNS = [
  [/^(DEGEN|MULTI)_MAX_POSITIONS$/, { min: 1, max: 10, int: true }],
  [/^(DEGEN|MULTI)_FLIP_PCT$/, { min: 1, max: 100 }],
  [/^(DEGEN|MULTI)_RANGE_(MIN_|MAX_)?PCT$/, { gt: 0, max: 99 }],
  [/^(DEGEN|MULTI)_(MAX_OPEN|LOW_VOLUME_BARS|MIN_LPS|MIN_HOLDERS|MIN_BIN_STEP)$/, { min: 0, int: true }],
  [/^(DEGEN|MULTI)_.*_(PCT|USD|MIN|H|SOL)$/, { min: 0 }],
  [/_(ATTEMPTS|RETRY)$/, { int: true }],
];

// File yang ditulis/dibaca bot: tidak boleh diarahkan ke rahasia atau state lain.
const PROTECTED_FILES = new Set([
  ".env",
  "wallet.key",
  "state.json",
  "settings.json",
  "strat.conf",
  "decision-log.json",
  "pnl-history.json",
  "package.json",
]);

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
  "AUTO_SCAN_INTERVAL_SEC",
  "JUPITER_POLL_INTERVAL_SEC",
  "LOG_LEVEL",
  "LOG_RETENTION_DAYS",
  "METEORA_MAX_PER_MIN",
  "GMGN_MAX_PER_MIN",
  "GMGN_MIN_GAP_SEC",
]);

// Komentar tepat di bawah header bagian (diakhiri baris kosong, sebelum key pertama) = deskripsi bagian.
export function parseStratText(text) {
  const sections = [{ title: "General", keys: [], description: "" }];
  const entries = {};
  let help = [];
  let afterHeader = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = line.match(HEADER_RE);
    if (header) {
      sections.push({ title: header[1], keys: [], description: "" });
      help = [];
      afterHeader = true;
      continue;
    }
    if (!line) {
      if (afterHeader && help.length > 0) sections[sections.length - 1].description = help.join("\n");
      afterHeader = false;
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
    afterHeader = false;
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
  const pattern = PATTERNS.find(([re]) => re.test(key))?.[1] || {};
  const o = { ...pattern, ...(OVERRIDES[key] || {}) };
  if (o.type === "enum") return { type: "enum", options: o.options };
  if (o.type === "list") return { type: "list" };
  if (o.type === "file") return { type: "file" };
  const d = String(def ?? "").trim();
  if (d === "true" || d === "false") return { type: "bool" };
  if (num(d, null) !== null) {
    const out = { type: "number" };
    const min = o.min ?? (o.gt === undefined && NON_NEGATIVE_SUFFIXES.some((s) => key.endsWith(s)) ? 0 : undefined);
    if (min !== undefined) out.min = min;
    if (o.gt !== undefined) out.gt = o.gt;
    if (o.max !== undefined) out.max = o.max;
    if (o.int) out.int = true;
    return out;
  }
  return { type: "string" };
}

export function rangeText(t) {
  const kind = t.int ? "whole number" : "number";
  if (t.min !== undefined && t.max !== undefined) return `${kind} between ${t.min} and ${t.max}`;
  if (t.gt !== undefined) return `${kind} > ${t.gt}`;
  if (t.min !== undefined) return `${kind} >= ${t.min}`;
  if (t.max !== undefined) return `${kind} <= ${t.max}`;
  return kind;
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
      const error = `${key} must be a ${rangeText(t)}`;
      if (!/^[+-]?\d+(\.\d+)?$/.test(v)) return { ok: false, error };
      const n = Number(v);
      const outOfRange =
        (t.min !== undefined && n < t.min) ||
        (t.gt !== undefined && n <= t.gt) ||
        (t.max !== undefined && n > t.max) ||
        (t.int && !Number.isInteger(n));
      if (!Number.isFinite(n) || outOfRange) return { ok: false, error };
      return { ok: true, value: String(n) };
    }
    case "file": {
      const bad = !v || /[\\/]/.test(v) || v.includes("..") || PROTECTED_FILES.has(v.toLowerCase());
      return bad
        ? { ok: false, error: `${key} must be a plain file name in the bot folder (not a state or secret file)` }
        : { ok: true, value: v };
    }
    default:
      return v ? { ok: true, value: v } : { ok: false, error: `${key} must not be empty` };
  }
}
