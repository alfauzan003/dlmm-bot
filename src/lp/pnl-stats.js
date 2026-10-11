// Statistik PnL per periode (kalender WIB = UTC+7). Murni, tanpa I/O.

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

// Awal periode (epoch ms) menurut kalender WIB: today = 00:00, week = Senin 00:00, month = tanggal 1 00:00.
export function periodStart(period, now = Date.now()) {
  const d = new Date(now + WIB_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (period === "today") return Date.UTC(y, m, day) - WIB_OFFSET_MS;
  if (period === "week") {
    const sinceMonday = (d.getUTCDay() + 6) % 7;
    return Date.UTC(y, m, day - sinceMonday) - WIB_OFFSET_MS;
  }
  if (period === "month") return Date.UTC(y, m, 1) - WIB_OFFSET_MS;
  throw new Error(`Unknown period: ${period}`);
}

const known = (t) => typeof t.closePnlUsd === "number" && Number.isFinite(t.closePnlUsd);

// Trade tanpa closePnlUsd ikut `count` tapi tidak ikut jumlah / win rate / best / worst.
export function summarize(closedTrades) {
  const withPnl = closedTrades.filter(known);
  const wins = withPnl.filter((t) => t.closePnlUsd > 0).length;
  let best = null;
  let worst = null;
  for (const t of withPnl) {
    if (!best || t.closePnlUsd > best.closePnlUsd) best = t;
    if (!worst || t.closePnlUsd < worst.closePnlUsd) worst = t;
  }
  return {
    count: closedTrades.length,
    wins,
    winRatePct: withPnl.length > 0 ? (wins / withPnl.length) * 100 : null,
    pnlUsd: withPnl.reduce((s, t) => s + t.closePnlUsd, 0),
    best,
    worst,
  };
}
