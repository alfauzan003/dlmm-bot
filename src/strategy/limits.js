// Batas buka posisi, cooldown, dan rem harian Auto Entry (murni, tanpa I/O). Waktu = epoch ms.
import { periodStart } from "../lp/pnl-stats.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);

// Waktu (ms) mint boleh dibuka lagi; 0 = tidak ada cooldown. Pakai close terakhir mint itu.
export function cooldownUntil(closed, mint, g) {
  let last = null;
  for (const t of closed) {
    if (t.baseMint === mint && fin(t.closedAt) && (!last || t.closedAt > last.closedAt)) last = t;
  }
  if (!last) return 0;
  const loss = fin(last.closePnlSol) ? last.closePnlSol < 0 : fin(last.closePnlUsd) && last.closePnlUsd < 0;
  return last.closedAt + (loss ? g.cooldownLossMin : g.cooldownMin) * 60000;
}

export function canOpen({ p, open, closed, mint, now, g }) {
  if (!p.on) return { ok: false, reason: "profile_off" };
  if (open.filter((t) => t.profile === p.name).length >= p.maxOpen) return { ok: false, reason: "max_open" };
  if (open.some((t) => t.baseMint === mint)) return { ok: false, reason: "token_open" };
  if (now < cooldownUntil(closed, mint, g)) return { ok: false, reason: "cooldown" };
  return { ok: true, reason: null };
}

// PnL hari ini (WIB) dalam SOL; USD dikonversi pakai solUsd, dilewati bila tidak ada harga.
export function todayAutoPnlSol(closed, solUsd, now) {
  const start = periodStart("today", now);
  let sum = 0;
  for (const t of closed) {
    if (!(t.closedAt >= start)) continue;
    if (fin(t.closePnlSol)) sum += t.closePnlSol;
    else if (fin(t.closePnlUsd) && Number.isFinite(solUsd) && solUsd > 0) sum += t.closePnlUsd / solUsd;
  }
  return sum;
}

export function brakeHit(pnlSol, g) {
  return g.dailyLossLimitSol > 0 && pnlSol <= -g.dailyLossLimitSol;
}
