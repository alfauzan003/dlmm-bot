// Pembentuk log naratif (bahasa manusia) untuk PM2. Baris teknis tetap
// dipisah lewat log.debug("[detail] ...").
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

// Bot menampilkan waktu dalam WIB (UTC+7).
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, "0");
}

export function clock(ts = Date.now()) {
  const d = new Date(ts + WIB_OFFSET_MS);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes()
  )}:${pad(d.getUTCSeconds())} WIB`;
}

export function fmtNum(v) {
  if (v == null) return "?";
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  if (n !== 0 && Math.abs(n) < 0.01) return n.toPrecision(3);
  return n.toFixed(n < 1 ? 4 : 2);
}

export function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return "?";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// Terjemahkan kode alasan exit ke bahasa manusia.
export function humanReason(reason) {
  if (!reason) return "alasan tidak diketahui";
  const r = String(reason);
  if (r.startsWith("trailing_tp")) return "profit turun dari puncak (trailing TP)";
  if (r.startsWith("indicator_trailing")) return "sinyal indikator, profit turun dari puncak";
  if (r === "stop_loss") return "batas rugi tersentuh";
  if (r === "oor_kanan") return "harga keluar dari rentang atas";
  if (r === "oor_kiri") return "harga keluar dari rentang bawah";
  if (r === "low_yield") return "yield rendah, PnL tidak minus";
  if (r.startsWith("bounce_recovery")) return "pemulihan gagal (turun dari pantulan)";
  if (r === "not_detected") return "posisi tidak terdeteksi (kemungkinan ditutup manual)";
  if (r === "rsi_macd") return "sinyal indikator RSI+MACD";
  if (r === "rsi_bb") return "sinyal indikator RSI+Bollinger";
  if (r === "rsi_bb_wick") return "sinyal indikator RSI+Bollinger (wick)";
  return r;
}

function trendLabel(trend) {
  if (trend === "bullish") return "tren NAIK";
  if (trend === "bearish") return "tren TURUN";
  return "tren belum siap";
}

function watchLine(w) {
  const name = w.pairName || `${w.pool.slice(0, 8)}…`;
  if (w.line == null || w.price == null) {
    return `${name} | ${trendLabel(w.trend)} | harga belum tersedia untuk dibandingkan`;
  }
  if (w.trend !== "bullish") {
    return `${name} | ${trendLabel(w.trend)} | harga ${fmtNum(w.price)} vs garis ${fmtNum(w.line)} → tidak dipantau untuk entry`;
  }
  const above = w.price > w.line;
  return `${name} | ${trendLabel(w.trend)} | harga ${fmtNum(w.price)} vs garis ${fmtNum(w.line)} → ${
    above ? "masih DI ATAS garis (menunggu turun)" : "sudah menyentuh garis (siap entry)"
  }`;
}

// Bangun blok ringkasan multi-baris (satu string).
export function buildSummaryBlock({ mode, now = Date.now(), watched = [], positions = [], actionLines = [] }) {
  const bar = "═".repeat(60);
  const L = [];
  L.push(bar);
  L.push(`  Meteora Bot — RINGKASAN   ${clock(now)}`);
  L.push(bar);
  L.push(`Mode    : ${mode} | PnL dihitung dalam SOL`);
  L.push("Kerja   : pantau tren → cari titik masuk → atur exit");
  L.push("");

  L.push(`▸ SEDANG DIPANTAU (${watched.length} pool)`);
  if (watched.length === 0) {
    L.push("  (belum ada pool dipantau — kosong, atau semua sedang punya posisi)");
  } else {
    watched.forEach((w, i) => L.push(`  ${i + 1}. ${watchLine(w)}`));
  }
  L.push("");

  L.push(`▸ POSISI TERBUKA : ${positions.length === 0 ? "tidak ada" : positions.length}`);
  positions.forEach((p, i) => {
    const name = p.pair || (p.position ? `${p.position.slice(0, 8)}…` : "?");
    const parts = [`PnL ${fmtPct(p.pnlPct)}`];
    if (p.zone) parts.push(p.zone);
    if (p.trailing) parts.push(p.trailing);
    L.push(`  ${i + 1}. ${name} | ${parts.join(" | ")}`);
  });
  L.push("");

  L.push("▸ AKSI 5 MENIT TERAKHIR");
  if (actionLines.length === 0) L.push("  tidak ada entry / close");
  else actionLines.forEach((line) => L.push(`  • ${line}`));

  return L.join("\n");
}
