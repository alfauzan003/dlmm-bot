import fs from "fs";
import { SETTINGS_FILE } from "../core/paths.js";

// Toggle yang bisa diubah dari Telegram; disimpan di settings.json.
export const TOGGLES = ["autoExit", "autoEntry", "deterministicExit", "dca"];

export const DEFAULT_SETTINGS = {
  autoExit: true,
  autoEntry: false,
  deterministicExit: false,
  dca: false,
  exitDefaults: { tpPct: 15, slPct: 25, trailStartPct: 5, trailDistancePct: 3 },
};

function withDefaults(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = { exitDefaults: { ...DEFAULT_SETTINGS.exitDefaults } };
  for (const name of TOGGLES) out[name] = typeof src[name] === "boolean" ? src[name] : DEFAULT_SETTINGS[name];
  const ed = src.exitDefaults && typeof src.exitDefaults === "object" ? src.exitDefaults : {};
  for (const key of Object.keys(out.exitDefaults)) {
    if (Number.isFinite(ed[key])) out.exitDefaults[key] = ed[key];
  }
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

// Exit awal untuk trade baru: Auto Exit ON → pakai default; OFF → semua mati.
export function exitPresetForNewTrade() {
  const { autoExit, exitDefaults: d } = getSettings();
  return {
    tp: { on: autoExit, pct: d.tpPct },
    sl: { on: autoExit, pct: d.slPct },
    trail: { on: autoExit, startPct: d.trailStartPct, distancePct: d.trailDistancePct },
  };
}
