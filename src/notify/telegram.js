import https from "https";
import config from "../config/index.js";
import log from "../core/logger.js";
import { getOORState, getTrackedPosition } from "../state/positions.js";
import { resolveTrailingReference } from "../exit/trailing.js";
import { trailingDropThreshold } from "../state/trailing.js";

const TOKEN = config.telegramBotToken;
const CHAT_ID = config.telegramChatId;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

function send(text) {
  if (!BASE || !CHAT_ID) return;
  const body = JSON.stringify({ chat_id: CHAT_ID, text: String(text).slice(0, 4096) });
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

export function notifyStartup(info = {}) {
  const lines = ["🤖 Meteora Bot — AKTIF", "━━━━━━━━━━━━━━━━━━"];

  if (info.mode) lines.push(`Mode     : ${info.mode}`);

  if (info.strategy) {
    const bins =
      info.binsBelow != null && info.binsAbove != null ? ` (bins -${info.binsBelow}/+${info.binsAbove})` : "";
    lines.push(`Strategy : ${info.strategy}${bins}`);
  }

  const entryParts = [];
  if (info.sizeSplit != null) entryParts.push(`split ${info.sizeSplit} SOL`);
  if (info.scanIntervalSec != null) entryParts.push(`refresh ${info.scanIntervalSec}s`);
  if (info.jupiterPollIntervalSec != null) entryParts.push(`Jupiter poll ${info.jupiterPollIntervalSec}s`);
  if (info.timeframe) entryParts.push(`TF ${info.timeframe}`);
  if (entryParts.length) lines.push(`Entry    : ${entryParts.join(" | ")}`);

  if (info.expiryHours != null) lines.push(`Expiry   : ${info.expiryHours} jam`);

  if (info.poolNames?.length) lines.push(`Pools    : ${info.poolNames.join(", ")}`);

  send(lines.join("\n"));
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
  return r;
}

export function buildCloseMessage(pair, reason, pnlPct, swapInfo, drawdownPnl = null, peakPnl = null) {
  const row = (label, value) => `${label.padEnd(16)}: ${value}`;
  const lines = [`🔒 Closed ${pair}`, "", row("Trigger Exit", exitLabel(reason))];
  if (peakPnl != null) lines.push(row("Peak", signedPct(peakPnl)));
  if (drawdownPnl != null) lines.push(row("Drawdown", signedPct(drawdownPnl)));
  lines.push("", row("Realized PnL", signedPct(pnlPct)));
  if (swapInfo && swapInfo.success === false) {
    const detail = swapInfo.error ? `: ${swapInfo.error}` : " — perlu swap manual";
    lines.push(`⚠️ Swap GAGAL${detail}`);
  }
  return lines.join("\n");
}

export function notifyClose(pair, reason, pnlPct, swapInfo, drawdownPnl = null, peakPnl = null) {
  send(buildCloseMessage(pair, reason, pnlPct, swapInfo, drawdownPnl, peakPnl));
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
