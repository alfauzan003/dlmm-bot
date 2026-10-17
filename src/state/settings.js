import fs from "fs";
import { SETTINGS_FILE } from "../core/paths.js";
import { RANGE_PRESETS } from "../lp/range.js";
import log from "../core/logger.js";
import { reloadConfig } from "../config/index.js";
import { loadStratSchema, validateValue } from "../config/strat-schema.js";

// Toggle yang bisa diubah dari Telegram; disimpan di settings.json.
export const TOGGLES = ["autoExit", "autoEntry"];

// Preset SOL-only = preset bawaan dengan above 0; tetap SOL-only walau diubah.
const SOL_ONLY_KEYS = new Set(RANGE_PRESETS.filter((p) => p.above === 0).map((p) => p.key));

export const DEFAULT_SETTINGS = {
  autoExit: true,
  autoEntry: false,
  exitDefaults: { tpPct: 15, slPct: 25, trailStartPct: 5, trailDistancePct: 3 },
  rangePresets: Object.fromEntries(RANGE_PRESETS.map((p) => [p.key, { below: p.below, above: p.above }])),
  depositPresets: [0.5, 0.7, 0.9, 1],
  // Default auto flip (%) untuk trade bid_ask/mixed baru dari /open; null = mati.
  autoFlipPct: null,
  // Override strat.conf dari Telegram: { KEY: "nilai" } (string, diparse seperti strat.conf).
  stratOverrides: {},
};

// Batas sama dengan range custom: below (0, 99], above [0, 1000]; preset SOL harus above 0.
function validRange(key, r) {
  if (!r || !Number.isFinite(r.below) || !Number.isFinite(r.above)) return false;
  if (!(r.below > 0 && r.below <= 99) || !(r.above >= 0 && r.above <= 1000)) return false;
  return SOL_ONLY_KEYS.has(key) ? r.above === 0 : true;
}

const validAutoFlipPct = (n) => Number.isFinite(n) && n >= 1 && n <= 100;

const validDeposits = (list) =>
  Array.isArray(list) && list.length === 4 && list.every((n) => Number.isFinite(n) && n > 0);

function withDefaults(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = { exitDefaults: { ...DEFAULT_SETTINGS.exitDefaults } };
  for (const name of TOGGLES) out[name] = typeof src[name] === "boolean" ? src[name] : DEFAULT_SETTINGS[name];
  const ed = src.exitDefaults && typeof src.exitDefaults === "object" ? src.exitDefaults : {};
  for (const key of Object.keys(out.exitDefaults)) {
    if (Number.isFinite(ed[key])) out.exitDefaults[key] = ed[key];
  }
  const rp = src.rangePresets && typeof src.rangePresets === "object" ? src.rangePresets : {};
  out.rangePresets = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS.rangePresets)) {
    out.rangePresets[key] = validRange(key, rp[key]) ? { below: rp[key].below, above: rp[key].above } : { ...def };
  }
  out.depositPresets = validDeposits(src.depositPresets)
    ? [...src.depositPresets]
    : [...DEFAULT_SETTINGS.depositPresets];
  out.autoFlipPct = validAutoFlipPct(src.autoFlipPct) ? src.autoFlipPct : null;
  const so = src.stratOverrides && typeof src.stratOverrides === "object" && !Array.isArray(src.stratOverrides);
  out.stratOverrides = so
    ? Object.fromEntries(Object.entries(src.stratOverrides).filter(([, v]) => typeof v === "string"))
    : {};
  return out;
}

function write(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function getSettings() {
  let raw;
  let exists = true;
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch (err) {
    exists = err?.code !== "ENOENT";
  }
  const settings = withDefaults(raw);
  if (!exists) write(settings);
  return settings;
}

export function isOn(name) {
  return getSettings()[name] === true;
}

export function setToggle(name, on) {
  if (!TOGGLES.includes(name)) throw new Error(`Unknown toggle: ${name}`);
  const settings = getSettings();
  settings[name] = Boolean(on);
  write(settings);
  return settings;
}

export function setExitDefaults(partial = {}) {
  const settings = getSettings();
  for (const key of Object.keys(settings.exitDefaults)) {
    if (Number.isFinite(partial[key])) settings.exitDefaults[key] = partial[key];
  }
  write(settings);
  return settings;
}

// Preset range untuk wizard /open: label bawaan + nilai dari settings.json.
export function getRangePresets() {
  const { rangePresets } = getSettings();
  return RANGE_PRESETS.map((p) => ({ key: p.key, label: p.label, ...rangePresets[p.key] }));
}

export function setRangePreset(key, { below, above }) {
  if (!(key in DEFAULT_SETTINGS.rangePresets)) throw new Error(`Unknown range preset: ${key}`);
  if (!validRange(key, { below, above })) throw new Error(`Invalid range for ${key}`);
  const settings = getSettings();
  settings.rangePresets[key] = { below, above };
  write(settings);
  return settings;
}

export function resetRangePresets() {
  const settings = getSettings();
  settings.rangePresets = withDefaults({}).rangePresets;
  write(settings);
  return settings;
}

// 4 tombol deposit cepat (SOL) di wizard /open.
export function getDepositPresets() {
  return getSettings().depositPresets;
}

export function setDepositPresets(list) {
  if (!validDeposits(list)) throw new Error("Deposit presets must be 4 positive amounts");
  const settings = getSettings();
  settings.depositPresets = [...list];
  write(settings);
  return settings;
}

export function resetDepositPresets() {
  const settings = getSettings();
  settings.depositPresets = [...DEFAULT_SETTINGS.depositPresets];
  write(settings);
  return settings;
}

// Default auto flip: 1..100 (%) atau null (mati).
export function setAutoFlipDefault(pct) {
  if (pct !== null && !validAutoFlipPct(pct)) throw new Error("Auto flip % must be 1-100 or off");
  const settings = getSettings();
  settings.autoFlipPct = pct;
  write(settings);
  return settings;
}

// Exit awal untuk trade baru: Auto Exit ON → pakai default; OFF → semua mati.
export function exitPresetForNewTrade() {
  const { autoExit, exitDefaults: d } = getSettings();
  return {
    tp: { on: autoExit, pct: d.tpPct },
    sl: { on: autoExit, pct: d.slPct },
    trail: { on: autoExit, startPct: d.trailStartPct, distancePct: d.trailDistancePct },
  };
}

export function getStratOverrides() {
  return getSettings().stratOverrides;
}

// Tulis settings lalu bangun ulang config; build gagal = isi file dikembalikan (config lama tetap).
function writeAndReload(settings) {
  let before = null;
  try {
    before = fs.readFileSync(SETTINGS_FILE, "utf8");
  } catch {
    before = null;
  }
  write(settings);
  try {
    reloadConfig();
  } catch (err) {
    if (before == null) fs.rmSync(SETTINGS_FILE, { force: true });
    else fs.writeFileSync(SETTINGS_FILE, before);
    throw err;
  }
}

export function setStratOverride(key, raw) {
  const res = validateValue(key, raw, loadStratSchema());
  if (!res.ok) return res;
  const settings = getSettings();
  const previous = settings.stratOverrides[key] ?? null;
  settings.stratOverrides[key] = res.value;
  try {
    writeAndReload(settings);
  } catch (err) {
    return { ok: false, error: `could not apply ${key}: ${err.message}` };
  }
  log.info(`Strat override ${key}: ${previous ?? "(default)"} → ${res.value}`);
  return { ok: true, value: res.value, previous };
}

export function clearStratOverride(key) {
  const settings = getSettings();
  if (!(key in settings.stratOverrides)) return;
  delete settings.stratOverrides[key];
  writeAndReload(settings);
  log.info(`Strat override ${key} cleared (back to strat.conf)`);
}

export function clearStratOverrides() {
  const settings = getSettings();
  settings.stratOverrides = {};
  writeAndReload(settings);
  log.info("All strat overrides cleared (back to strat.conf)");
}
