import https from "https";
import config from "../config/index.js";
import log from "../core/logger.js";
import { getOORState, getTrackedPosition } from "../state/positions.js";
import { resolveTrailingReference } from "../exit/trailing.js";
import { trailingDropThreshold } from "../state/trailing.js";
import { esc, fmtPct, fmtUsd } from "../tg/format.js";

const TOKEN = config.telegramBotToken;
const CHAT_ID = config.telegramChatId;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

const METLEX_URL = "https://www.metlex.io/pnl-cards";
const METLEX_KEYBOARD = { inline_keyboard: [[{ text: "🖼 Open Metlex", url: METLEX_URL }]] };

function rawSend(text, extra = {}) {
  if (!BASE || !CHAT_ID) return;
  const payload = { chat_id: CHAT_ID, text: String(text).slice(0, 4096) };
  if (extra.parse_mode) payload.parse_mode = extra.parse_mode;
  if (extra.reply_markup) payload.reply_markup = extra.reply_markup;
  const body = JSON.stringify(payload);
  const url = new URL(`${BASE}/sendMessage`);
  const req = https.request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      family: 4,
      timeout: 15000,
    },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          log.warn(`Telegram send failed: ${res.statusCode} ${data.slice(0, 200)}`);
        }
      });
    }
  );
  req.on("error", (err) => log.warn(`Telegram error: ${err.message}`));
  req.write(body);
  req.end();
}

// Pengirim level-bawah; hanya untuk tes (tangkap payload tanpa jaringan).
let sender = rawSend;
export function __setSender(fn) {
  sender = typeof fn === "function" ? fn : rawSend;
}

function send(text, extra = {}) {
  return sender(text, extra);
}

export function notifyEntry({ pair, pool, feeMode, feeSol }) {
  const mode = feeMode || config.entry.fees.mode;
  const lines = [`🚀 ENTRY ${pair || pool?.slice(0, 8) || ""}`, `Pool: ${pool || "?"}`];
  if (mode && mode !== "none") {
    lines.push(`Fee: ${mode}${feeSol > 0 ? ` (~${feeSol.toFixed(6)} SOL)` : ""}`);
  }
  send(lines.join("\n"));
}

export function notifyDca({ pair, pool, pnlPct, sizeSol }) {
  const pnlStr = pnlPct != null ? `${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "?";
  send(
    `📉 DCA ${pair || pool?.slice(0, 8) || ""}\nEntry baru: ${sizeSol} SOL\nPool: ${pool || "?"}\nTrigger PnL: ${pnlStr}`
  );
}

// Fallback OOR kiri spot: beri tahu hasil konversi ke posisi token-only.
export function notifyFallback({ pair, pool, success, amount, error }) {
  const label = pair || pool?.slice(0, 8) || "";
  if (success) {
    send(`↩️ FALLBACK ${label}\nOOR kiri → posisi token-only dibuka\nToken: ${amount}\nPool: ${pool || "?"}`);
  } else {
    send(
      `⚠️ FALLBACK ${label} GAGAL\nPosisi token-only tidak jadi dibuka${error ? `: ${error}` : ""}\nToken dibiarkan di wallet.\nPool: ${pool || "?"}`
    );
  }
}

// Re-entry spot OOR kanan: beri tahu hasil membuka posisi spot baru.
export function notifySpotReentry({ pair, pool, sizeSol, attempt, max, bins, success, error, reason }) {
  const label = pair || pool?.slice(0, 8) || "";
  if (success) {
    send(
      `🔁 RE-ENTRY ${label}\nOOR kanan → posisi spot dibuka lagi (${attempt}/${max})\nSize: ${sizeSol} SOL | Range: ${bins} bin ke bawah\nPool: ${pool || "?"}`
    );
  } else {
    const detail = reason || error;
    send(
      `⚠️ RE-ENTRY ${label} TIDAK dibuka (${attempt}/${max})\n${detail ? `${detail}\n` : ""}Rantai re-entry dihentikan.\nPool: ${pool || "?"}`
    );
  }
}

function signedPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return "?";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// Label pendek untuk alasan exit (bukan kalimat naratif).
export function exitLabel(reason) {
  if (!reason) return "?";
  const r = String(reason);
  if (r.startsWith("trailing_tp")) return "Trailing TP";
  if (r.startsWith("indicator_trailing")) return "Trailing Indikator";
  if (r === "stop_loss") return "Stop Loss";
  if (r === "oor_kanan") return "OOR Kanan";
  if (r === "oor_kiri") return "OOR Kiri";
  if (r === "low_yield") return "Yield Rendah";
  if (r.startsWith("bounce_recovery")) return "Bounce Recovery";
  if (r === "not_detected") return "Tidak Terdeteksi";
  if (r === "tp") return "Take Profit";
  if (r === "sl") return "Stop Loss";
  if (r === "trail") return "Trailing";
  if (r === "manual") return "Manual close";
  if (r === "closed_outside") return "Closed outside bot";
  return r;
}

// Dengan `closeTx` pesan berformat HTML (tx tap-to-copy di <code>), jadi semua
// teks dinamis di-escape. Tanpa closeTx tetap teks biasa seperti semula.
export function buildCloseMessage(
  pair,
  reason,
  pnlPct,
  swapInfo,
  drawdownPnl = null,
  peakPnl = null,
  { closeTx } = {}
) {
  const e = closeTx ? esc : (v) => v;
  const row = (label, value) => `${label.padEnd(16)}: ${value}`;
  const lines = [`🔒 Closed ${e(pair)}`, "", row("Trigger Exit", e(exitLabel(reason)))];
  if (peakPnl != null) lines.push(row("Peak", signedPct(peakPnl)));
  if (drawdownPnl != null) lines.push(row("Drawdown", signedPct(drawdownPnl)));
  lines.push("", row("Realized PnL", signedPct(pnlPct)));
  if (swapInfo && swapInfo.success === false) {
    const detail = swapInfo.error ? `: ${e(swapInfo.error)}` : " — perlu swap manual";
    lines.push(`⚠️ Swap GAGAL${detail}`);
  }
  if (closeTx) lines.push("", `Tx: <code>${esc(closeTx)}</code>`);
  return lines.join("\n");
}

export function notifyClose(pair, reason, pnlPct, swapInfo, drawdownPnl = null, peakPnl = null, { closeTx } = {}) {
  const text = buildCloseMessage(pair, reason, pnlPct, swapInfo, drawdownPnl, peakPnl, { closeTx });
  if (closeTx) send(text, { parse_mode: "HTML", reply_markup: METLEX_KEYBOARD });
  else send(text);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "under 1m";
  const h = Math.floor(mins / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

// Alert close untuk satu trade utuh (semua leg sudah tutup).
export function notifyTradeClosed(trade, { swapInfo = null } = {}) {
  const lines = [
    `🔒 Trade #${trade.id} closed — ${esc(trade.pair)}`,
    "",
    `Reason: ${esc(exitLabel(trade.closeReason))}`,
    `PnL: ${trade.closePnlUsd > 0 ? "+" : ""}${fmtUsd(trade.closePnlUsd)} (${fmtPct(trade.closePnlPct)})`,
    `Duration: ${fmtDuration(trade.closedAt - trade.openedAt)}`,
  ];
  if (swapInfo && swapInfo.success === false) {
    lines.push(`⚠️ Swap failed${swapInfo.error ? `: ${esc(swapInfo.error)}` : " — swap manually"}`);
  }
  if (trade.closeTx) lines.push("", `Tx: <code>${esc(trade.closeTx)}</code>`);
  send(lines.join("\n"), { parse_mode: "HTML", reply_markup: METLEX_KEYBOARD });
}

export function notifyError(msg) {
  send(`❌ Error: ${msg}`);
}

export function notifyPositionMissing(position, pair, cycles) {
  const short = position?.slice(0, 8) || "?";
  send(`posisi ${short} dari pool ${pair || "?"} tidak terbaca ${cycles} cycle.`);
}

export function notifyPoolExpired({ pool, pair, expiryHours }) {
  const label = pair || pool;
  send(
    `⏰ Pool EXPIRED: ${label}\nPool: ${pool}\nTidak ada entry dalam ${expiryHours} jam — pool di-skip dari scan sampai bot restart.`
  );
}

export function notifyPoolUnsupported({ pool, pair, quoteMint }) {
  const label = pair || pool;
  send(
    `⛔ Pool DITOLAK: ${label}\nPool: ${pool}\nPair bukan SOL (quote: ${quoteMint || "?"}) — pool dilewati dari scan sampai bot restart.`
  );
}

export function notifyEntryFailed({ pool, pair, error, attempts, maxFailures, cooldownSec }) {
  const label = pair || pool;
  const lines = [
    `⚠️ ENTRY GAGAL: ${label}`,
    `Pool: ${pool}`,
    `Alasan: ${error || "unknown"}`,
    `Percobaan: ${attempts}${maxFailures != null ? `/${maxFailures}` : ""}`,
  ];
  if (config.entry.fees.mode !== "none") lines.push(`Fee: ${config.entry.fees.mode}`);
  if (cooldownSec > 0) lines.push(`Cooldown: ${cooldownSec}s`);
  send(lines.join("\n"));
}

export function notifyEntryRateLimited({ pool, pair, error, attempts, maxFailures, cooldownSec }) {
  const label = pair || pool;
  const lines = [
    `⚠️ ENTRY GAGAL (RATE LIMIT): ${label}`,
    `Pool: ${pool}`,
    `Alasan: ${error || "unknown"}`,
    `Percobaan: ${attempts}/${maxFailures}`,
  ];
  if (cooldownSec > 0) lines.push(`Cooldown: ${cooldownSec}s`);
  if (maxFailures != null && attempts >= maxFailures) lines.push("Pool di-skip sampai bot restart.");
  send(lines.join("\n"));
}

export function notifyEntryAborted({ pool, pair, attempts, error }) {
  const label = pair || pool;
  send(
    `⛔ ENTRY DIBATALKAN: ${label}\nPool: ${pool}\nGagal ${attempts}x berturut-turut — ${error || "unknown"}.\nPool di-skip sampai bot restart.`
  );
}

function emoji(v) {
  if (v == null || v === 0) return "";
  return v > 0 ? "🟢" : "🔴";
}

// OOR hanya dikembalikan saat posisi benar-benar keluar rentang.
function oorMarker(p) {
  if (p.activeBin == null || p.lowerBin == null || p.upperBin == null) return null;
  const state = getOORState(p.position);
  if (state) return state.arah === "kanan" ? "OOR 🟢" : "OOR 🔴";
  if (p.activeBin > p.upperBin) return "OOR 🟢";
  if (p.activeBin < p.lowerBin) return "OOR 🔴";
  return null;
}

// Level PnL yang akan memicu exit saat ini (trailing aktif, atau stop loss).
function computeExitAt(p, tracked) {
  const rules = config.rulesFor(p.mode || "bidask:double");
  if (tracked && p.pnlPct != null) {
    const resolved = resolveTrailingReference(tracked, p.pnlPct, rules);
    if (resolved) {
      const threshold = trailingDropThreshold(resolved.reference, rules.trailingDropRatioPct, rules.trailingDropPct);
      return resolved.reference - threshold;
    }
  }
  if (rules.enableStopLoss) return rules.stopLossPct;
  return null;
}

export function buildStatusMessage(positions) {
  if (!positions || positions.length === 0) return "";
  let msg = "🚨 Meteora DLMM Position Status:\n";
  for (const p of positions) {
    const label = p.pair || p.position?.slice(0, 8) || "?";
    const age = p.ageMinutes != null ? `${p.ageMinutes}m` : "?m";
    const tracked = getTrackedPosition(p.position);

    msg += `\n${label}\n`;
    msg += `Age : ${age}\n`;

    if (p.pnlPct != null) {
      msg += `PnL: ${signedPct(p.pnlPct)}${emoji(p.pnlPct)}\n`;
    }

    // Yield selalu tampil; info OOR hanya muncul saat keluar rentang.
    const yieldPct = p.feePct24h != null && p.feePct24h > 0 ? `${p.feePct24h.toFixed(2)}%` : null;
    const yieldLine = [yieldPct, oorMarker(p)].filter(Boolean).join(" | ");
    if (yieldLine) msg += `Yield: ${yieldLine}\n`;

    if (tracked?.trailingActive) {
      msg += `Trailing: 🔁\n`;
      if (tracked.lastPnlPeak != null) msg += `Peak: ${signedPct(tracked.lastPnlPeak)}\n`;
    }
    const exitAt = computeExitAt(p, tracked);
    if (exitAt != null) msg += `Exit at : ${signedPct(exitAt)}\n`;
  }
  return msg.trim();
}

export function notifyStatus(positions) {
  const msg = buildStatusMessage(positions);
  if (msg) send(msg);
}
