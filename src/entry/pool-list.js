import fs from "fs";
import path from "path";
import config from "../config/index.js";
import log from "../core/logger.js";
import { ROOT } from "../core/paths.js";

function poolListPath() {
  return path.resolve(ROOT, config.entry.poolListFile);
}

// Baris `alamat` saja memakai default dari .env (ENTRY_DEFAULT_SIZE_SOL /
// ENTRY_DEFAULT_MAX_POSITION); `alamat,size,max` tetap meng-override.
export function parsePoolList(raw) {
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [address, sizeRaw, maxRaw] = trimmed.split(",").map((s) => s.trim());
    if (!address) continue;

    const sizeSol = sizeRaw ? Number(sizeRaw) : config.entry.defaultSizeSol;
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
      log.warn(
        `Pool ${address.slice(0, 8)} skipped: entry_size invalid "${sizeRaw ?? ""}" (set ENTRY_DEFAULT_SIZE_SOL atau tulis alamat,size,max)`
      );
      continue;
    }

    const maxNum = maxRaw ? Number(maxRaw) : config.entry.defaultMaxPositions;
    const maxPositions = Number.isFinite(maxNum) && maxNum > 0 ? Math.floor(maxNum) : config.entry.defaultMaxPositions;
    entries.push({ pool: address, sizeSol, maxPositions });
  }
  return entries;
}

export function loadPoolList() {
  const file = poolListPath();
  if (!fs.existsSync(file)) {
    log.warn(`Pool list not found: ${file}`);
    return [];
  }
  return parsePoolList(fs.readFileSync(file, "utf8"));
}

// Beri `#` di depan semua baris aktif milik pool ini agar tidak dipantau lagi
// (menu manual: hapus `#` untuk mengaktifkan kembali). Return false hanya bila
// penulisan gagal, supaya pemanggil bisa fallback ke skip runtime.
export function commentPoolInList(poolAddress) {
  if (!poolAddress) return false;
  const file = poolListPath();
  try {
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let active = false;
    const out = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      if (trimmed.split(",")[0].trim() !== poolAddress) return line;
      active = true;
      return `#${line}`;
    });
    if (!active) return true;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, out.join("\n"));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log.warn(`Gagal menandai pool ${poolAddress.slice(0, 8)} di ${config.entry.poolListFile}: ${err.message}`);
    return false;
  }
}
