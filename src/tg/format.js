// Formatter murni untuk teks Telegram (tanpa side effect).

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

export function fmtUsd(n) {
  if (!isNum(n)) return "?";
  const abs = Math.abs(n).toFixed(2);
  return `${n < 0 && Number(abs) !== 0 ? "-" : ""}$${abs}`;
}

export function fmtPct(n) {
  if (!isNum(n)) return "?";
  const abs = Math.abs(n).toFixed(2);
  return `${n < 0 && Number(abs) !== 0 ? "-" : "+"}${abs}%`;
}

export function fmtSol(n) {
  if (!isNum(n)) return "?";
  return `${Number(n.toFixed(4))} SOL`;
}

export function shortAddr(a) {
  const s = String(a ?? "");
  return s.length <= 9 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function fmtWib(ms) {
  const d = new Date(ms + WIB_OFFSET_MS);
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} WIB`;
}

// Durasi → "45m", "2h", "3d 4h".
export function fmtAge(ms) {
  if (!isNum(ms) || ms < 0) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// exit = { tp:{on,pct}, sl:{on,pct}, trail:{on,startPct,distancePct} } → "TP15 SL-25 T5/3"
export function exitSummary(exit) {
  const parts = [];
  if (exit?.tp?.on) parts.push(`TP${exit.tp.pct}`);
  if (exit?.sl?.on) parts.push(`SL-${exit.sl.pct}`);
  if (exit?.trail?.on) parts.push(`T${exit.trail.startPct}/${exit.trail.distancePct}`);
  return parts.length ? parts.join(" ") : "no exits";
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
