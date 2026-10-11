// Evaluasi TP/SL/Trail per trade (murni, tanpa I/O). Dipakai loop exit dan /positions.

// PnL gabungan leg trade yang masih terbuka, dalam USD. `positionsByAddr` hanya berisi posisi live;
// leg yang `isClosed(addr)` (sudah tertutup di state) dilewati. Setiap leg terbuka harus ada dan
// pnlKnown === true, selain itu null (belum ter-index -> jangan memicu exit); null juga bila
// tidak ada leg terbuka.
// Deposit leg hasil flip (`trade.flipLegs`) tidak dijumlah: nilainya sudah terhitung di leg asal
// (Meteora mencatatnya sebagai penarikan); dipakai hanya bila tinggal leg flip yang terbuka.
export function aggregateTradePnl(trade, positionsByAddr, { isClosed = () => false } = {}) {
  const flipLegs = new Set(trade?.flipLegs || []);
  let pnlUsd = 0;
  let depositUsd = 0;
  let flipDepositUsd = 0;
  for (const addr of trade?.positions || []) {
    if (isClosed(addr)) continue;
    const p = positionsByAddr?.get(addr);
    if (!p || p.pnlKnown !== true) return null;
    if (!Number.isFinite(p.pnlUsd) || !(p.depositUsd > 0)) return null;
    pnlUsd += p.pnlUsd;
    if (flipLegs.has(addr)) flipDepositUsd += p.depositUsd;
    else depositUsd += p.depositUsd;
  }
  if (!(depositUsd > 0)) depositUsd = flipDepositUsd;
  if (!(depositUsd > 0)) return null;
  return { pnlUsd, depositUsd, pnlPct: (pnlUsd / depositUsd) * 100 };
}

// Urutan: SL, TP, Trail. Peak selalu dilacak saat PnL diketahui; trail aktif
// (armed) begitu pnl >= startPct, lalu close bila pnl <= peak - distancePct.
export function evaluateTradeExit(trade, pnlPct) {
  const prevPeak = Number.isFinite(trade.peakPnlPct) ? trade.peakPnlPct : null;
  const prevArmed = trade.trailArmed === true;
  if (pnlPct == null || !Number.isFinite(pnlPct)) {
    return { reason: null, peakPnlPct: prevPeak, trailArmed: trade.trailArmed };
  }

  const peakPnlPct = prevPeak == null ? pnlPct : Math.max(prevPeak, pnlPct);
  const { tp, sl, trail } = trade.exit || {};
  const trailArmed = prevArmed || (trail?.on === true && pnlPct >= trail.startPct);

  let reason = null;
  if (sl?.on && pnlPct <= -sl.pct) reason = "sl";
  else if (tp?.on && pnlPct >= tp.pct) reason = "tp";
  else if (trail?.on && trailArmed && pnlPct <= peakPnlPct - trail.distancePct) reason = "trail";

  return { reason, peakPnlPct, trailArmed };
}
