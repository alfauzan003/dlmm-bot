import fs from "fs";
import { SETTINGS_FILE } from "../core/paths.js";
import { RANGE_PRESETS } from "../lp/range.js";

// Toggle yang bisa diubah dari Telegram; disimpan di settings.json.
export const TOGGLES = ["autoExit", "autoEntry", "deterministicExit", "dca"];

// Preset SOL-only = preset bawaan dengan above 0; tetap SOL-only walau diubah.
const SOL_ONLY_KEYS = new Set(RANGE_PRESETS.filter((p) => p.above === 0).map((p) => p.key));

export const DEFAULT_SETTINGS = {
  autoExit: true,
  autoEntry: false,
  deterministicExit: false,
  dca: false,
  exitDefaults: { tpPct: 15, slPct: 25, trailStartPct: 5, trailDistancePct: 3 },
  rangePresets: Object.fromEntries(RANGE_PRESETS.map((p) => [p.key, { below: p.below, above: p.above }])),
  depositPresets: [0.5, 0.7, 0.9, 1],
  // Default auto flip (%) untuk trade bid_ask/mixed baru dari /open; null = mati.
  autoFlipPct: null,
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
