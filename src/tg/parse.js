// Parser input teks Telegram (murni, tanpa side effect).

const BASE58 = "1-9A-HJ-NP-Za-km-z";
// Run base58 32–44 karakter; run yang lebih panjang (private key, signature) bukan alamat.
const ADDRESS_RE = new RegExp(`(?<![${BASE58}])[${BASE58}]{32,44}(?![${BASE58}])`);
const NUMBER_RE = /^(\d+|\d*[.,]\d+)$/;

// "12", "12.5", "12,5" -> angka; selain itu NaN (menolak "1e3", "0x10", string kosong).
function toNumber(s) {
  const t = String(s ?? "").trim();
  return NUMBER_RE.test(t) ? Number(t.replace(",", ".")) : NaN;
}

export function parseSolAmount(text) {
  const n = toNumber(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function extractAddress(text) {
  const m = ADDRESS_RE.exec(String(text ?? ""));
  return m ? m[0] : null;
}

// kind: "tp" | "sl" | "trail". "off" -> { on:false }. Tidak valid -> null.
export function parseExitInput(kind, text) {
  const raw = String(text ?? "").trim();
  if (raw.toLowerCase() === "off") return { on: false };

  if (kind === "trail") {
    const parts = raw.split(/\s+/);
    if (parts.length !== 2) return null;
    const [startPct, distancePct] = parts.map(toNumber);
    if (!Number.isFinite(startPct) || !Number.isFinite(distancePct) || distancePct <= 0) return null;
    return { on: true, startPct, distancePct };
  }

  if (kind !== "tp" && kind !== "sl") return null;
  // Tanda +/- di depan diterima: "-25" untuk SL berarti 25; "+" untuk TP.
  const sign = raw[0];
  const body = sign === "+" || (sign === "-" && kind === "sl") ? raw.slice(1) : raw;
  const pct = toNumber(body);
  return Number.isFinite(pct) && pct > 0 && pct <= 1000 ? { on: true, pct } : null;
}
