import fs from "fs";
import { STATE_FILE } from "../core/paths.js";

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { positions: {} };
  }
}

export function writeState(data) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

export function readJsonArray(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
