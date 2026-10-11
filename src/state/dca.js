import { readState, writeState } from "./store.js";

// --- Eligibility ---

export function isDcaEligible(tracked) {
  if (!tracked || tracked.closed) return false;
  if (tracked.dcaTriggered) return false;
  return true;
}

// Ambang arm efektif untuk DCA berikutnya di sebuah pool.
// - count 0 -> DCA#1 dari posisi utama, pakai armPct.
// - count 1 -> DCA#2: kalau DCA#1 masih open, acuan posisi DCA#1 pakai armPct;
//   kalau DCA#1 sudah close, acuan posisi utama pakai armPct2.
// - count >= maxAdds ditangani pemanggil (tidak ada DCA lagi).
export function effectiveDcaArmPct(count, dcaOpen, cfg) {
  const armPct = cfg?.armPct;
  if (count === 1 && !dcaOpen) {
    return Number.isFinite(cfg?.armPct2) ? cfg.armPct2 : armPct;
  }
  return armPct;
}

// --- Pure decision (dipakai processDca + test) ---

// evaluateDca memutuskan aksi DCA dari PnL saat ini + state tracking.
// Murni (tanpa I/O) supaya mudah diuji.
export function evaluateDca(position, tracked, cfg) {
  if (!cfg?.enabled) return { action: "noop", reason: "disabled" };
  if (!position || position.pnlPct == null) return { action: "noop", reason: "no_pnl" };
  if (!tracked || tracked.closed) return { action: "noop", reason: "not_tracked" };
  if (tracked.dcaTriggered) return { action: "noop", reason: "already_triggered" };

  const pnl = position.pnlPct;
  const armed = tracked.dcaArmed === true;
  const trough = Number.isFinite(tracked.dcaTrough) ? tracked.dcaTrough : null;

  if (!armed) {
    if (pnl <= cfg.armPct) return { action: "arm", trough: pnl };
    return { action: "noop", reason: "not_armed" };
  }

  if (trough == null) return { action: "arm", trough: pnl };
  if (pnl < trough) return { action: "trail", trough: pnl };

  const rebound = pnl - trough;
  if (rebound >= cfg.reboundPct) {
    return { action: "queue_rebound", trough, current: pnl, rebound };
  }
  return { action: "hold", trough, rebound };
}

// --- State mutations (persisten) ---

export function setDcaArmedAndTrough(positionAddress, trough) {
  if (!positionAddress || !Number.isFinite(trough)) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || !isDcaEligible(p)) return null;
  p.dcaArmed = true;
  if (p.dcaArmedAt == null) p.dcaArmedAt = Date.now();
  if (p.dcaTrough == null || trough < p.dcaTrough) p.dcaTrough = trough;
  writeState(state);
  return p.dcaTrough;
}

export function queueDcaRebound(positionAddress, trough, currentPnl) {
  if (!positionAddress || trough == null || currentPnl == null) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || !isDcaEligible(p)) return;
  p.pendingDcaTrough = trough;
  p.pendingDcaCurrent = currentPnl;
  p.pendingDcaStartedAt = Date.now();
  writeState(state);
}

export function clearPendingDca(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.pendingDcaTrough = null;
  p.pendingDcaCurrent = null;
  p.pendingDcaStartedAt = null;
  writeState(state);
}

// Resolusi konfirmasi: rebound sah bila saat dicek ulang PnL masih minimal
// `reboundPct` di atas trough. Jika balik turun, pending dibatalkan dan trough
// diperbarui bila makin dalam (lalu trail lanjut).
export function resolvePendingDca(positionAddress, currentPnl, reboundPct) {
  if (!positionAddress) return { confirmed: false, pending: false };
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.closed || p.pendingDcaTrough == null || p.pendingDcaCurrent == null) {
    return { confirmed: false, pending: false };
  }

  const trough = p.pendingDcaTrough;
  p.pendingDcaTrough = null;
  p.pendingDcaCurrent = null;
  p.pendingDcaStartedAt = null;

  const threshold = Number.isFinite(Number(reboundPct)) ? Math.max(0, Number(reboundPct)) : 0;
  const stillRebounded = currentPnl != null && currentPnl - trough >= threshold;

  if (stillRebounded) {
    writeState(state);
    return { confirmed: true, trough, current: currentPnl };
  }

  if (currentPnl != null && (p.dcaTrough == null || currentPnl < p.dcaTrough)) {
    p.dcaTrough = currentPnl;
  }
  writeState(state);
  return { confirmed: false, rejected: true };
}

export function markDcaTriggered(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.dcaTriggered = true;
  p.dcaTriggeredAt = Date.now();
  p.pendingDcaTrough = null;
  p.pendingDcaCurrent = null;
  p.pendingDcaStartedAt = null;
  writeState(state);
}

// Batalkan flag trigger (mis. eksekusi gagal) agar posisi bisa memicu lagi
// setelah cooldown pool berakhir.
export function clearDcaTriggered(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.dcaTriggered = false;
  p.dcaTriggeredAt = null;
  writeState(state);
}

function clearDcaFields(p) {
  p.dcaArmed = false;
  p.dcaTrough = null;
  p.dcaArmedAt = null;
  p.dcaTriggered = false;
  p.dcaTriggeredAt = null;
  p.pendingDcaTrough = null;
  p.pendingDcaCurrent = null;
  p.pendingDcaStartedAt = null;
}

export function clearDcaState(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  clearDcaFields(p);
  writeState(state);
}

// Setelah posisi DCA ditutup, buka lagi kesempatan DCA berikutnya untuk posisi
// lain yang masih terbuka di pool yang sama (mis. posisi utama arm ulang untuk
// DCA#2). Reset penuh agar mereka harus arm ulang sebelum memicu DCA berikutnya.
export function resetPoolDcaState(pool, exceptPosition) {
  if (!pool) return;
  const state = readState();
  let changed = false;
  for (const p of Object.values(state.positions)) {
    if (!p || p.closed === true) continue;
    if (p.pool !== pool || p.position === exceptPosition) continue;
    clearDcaFields(p);
    changed = true;
  }
  if (changed) writeState(state);
}

// --- Safeguard: close posisi asli saat DCA terakhir exit karena trailing TP ---

// Pure: apakah alasan close berasal dari trailing TP peak (bukan indikator)?
export function isTrailingTpReason(reason) {
  return typeof reason === "string" && reason.startsWith("trailing_tp");
}

// Tandai posisi asli (non-DCA) di pool agar ikut ditutup oleh loop exit.
// Mengembalikan jumlah posisi yang ditandai.
export function markPoolDcaCloseSafeguard(pool, exceptPosition) {
  if (!pool) return 0;
  const state = readState();
  let marked = 0;
  for (const p of Object.values(state.positions)) {
    if (!p || p.closed === true) continue;
    if (p.pool !== pool || p.position === exceptPosition) continue;
    if (p.isDca === true) continue;
    p.dcaCloseSafeguard = true;
    marked++;
  }
  if (marked > 0) writeState(state);
  return marked;
}

// --- Counter DCA per sesi (persisten di state.dcaUsage) ---
// Sesi = rentang saat pool punya >=1 posisi terbuka. Counter naik saat trigger
// DCA (sebelum eksekusi, jadi aman crash) dan di-reset saat sesi berakhir
// (pool tidak lagi punya posisi terbuka). Inilah yang membatasi DCA_MAX_ADDS
// per sesi sekaligus tahan restart. Tanpa refund: slot DCA yang sudah dipakai
// tidak bisa dibuka ulang.

export function getPoolDcaCount(pool) {
  if (!pool) return 0;
  const state = readState();
  return state.dcaUsage?.[pool] || 0;
}

export function incrementPoolDca(pool) {
  if (!pool) return 0;
  const state = readState();
  if (!state.dcaUsage) state.dcaUsage = {};
  const n = (state.dcaUsage[pool] || 0) + 1;
  state.dcaUsage[pool] = n;
  writeState(state);
  return n;
}

// Batalkan reservasi (mis. eksekusi DCA gagal) agar bisa dicoba lagi.
export function decrementPoolDca(pool) {
  if (!pool) return 0;
  const state = readState();
  if (!state.dcaUsage || !(pool in state.dcaUsage)) return 0;
  const n = Math.max(0, (state.dcaUsage[pool] || 0) - 1);
  if (n === 0) delete state.dcaUsage[pool];
  else state.dcaUsage[pool] = n;
  writeState(state);
  return n;
}

export function resetPoolDca(pool) {
  if (!pool) return;
  const state = readState();
  if (!state.dcaUsage || !(pool in state.dcaUsage)) return;
  delete state.dcaUsage[pool];
  writeState(state);
}

// Reset counter untuk pool yang tidak ada di `activePools` (sesi berakhir).
// `activePools` = pool dengan posisi terbuka + pool in-flight + pool closing.
export function resetStaleDcaPools(activePools) {
  const active = activePools instanceof Set ? activePools : new Set(activePools || []);
  const state = readState();
  if (!state.dcaUsage) return;
  let changed = false;
  for (const pool of Object.keys(state.dcaUsage)) {
    if (!active.has(pool)) {
      delete state.dcaUsage[pool];
      changed = true;
    }
  }
  if (changed) writeState(state);
}
