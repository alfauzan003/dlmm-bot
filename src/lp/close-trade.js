import log from "../core/logger.js";
import { handleClose } from "../exit/close.js";
import { notifyTradeClosed } from "../notify/telegram.js";
import { getTrackedPosition } from "../state/positions.js";
import { getTrade, settleTradeIfDone, tryLockTrade, unlockTrade } from "../state/trades.js";
import { swapBaseToSol } from "./claim.js";

// Tutup semua leg satu trade (tanpa alert per-leg), swap base token sekali,
// lalu selesaikan trade dan kirim satu alert. Leg yang gagal membuat trade
// tetap terbuka (bisa dicoba lagi); leg yang sudah tertutup dilewati.
export async function closeTrade(trade, { reason, swap = true, positionsByAddr = new Map(), deps = {} } = {}) {
  const close = deps.handleClose ?? handleClose;
  const notify = deps.notifyTradeClosed ?? notifyTradeClosed;

  if (!tryLockTrade(trade.id, "close")) return { success: false, busy: true, failed: [], swapInfo: null };

  try {
    const t = getTrade(trade.id) ?? trade;
    if (t.closed === true) return { success: true, trade: t, failed: [], swapInfo: null };

    let closedNow = 0;
    const failed = [];
    for (const addr of t.positions) {
      if (getTrackedPosition(addr)?.closed === true) continue;
      const pos = positionsByAddr.get(addr) ?? { position: addr, pool: t.pool, pair: t.pair, baseMint: t.baseMint };
      try {
        const res = await close(pos, reason, { skipAutoSwap: true, silent: true, skipDeactivate: true });
        if (res?.success) closedNow++;
        else failed.push(addr);
      } catch (err) {
        failed.push(addr);
        log.warn(`closeTrade #${t.id}: leg ${addr.slice(0, 8)} error: ${err.message}`);
      }
    }

    // Token dari leg yang sudah tertutup di-swap sekali, walau ada leg lain yang gagal.
    const swapInfo = swap && closedNow > 0 ? await swapBaseToSol(t.baseMint, deps) : null;

    if (failed.length > 0) {
      log.warn(`closeTrade #${t.id}: ${failed.length} leg gagal — trade tetap terbuka`);
      return { success: false, trade: getTrade(t.id), failed, swapInfo };
    }

    const settled = settleTradeIfDone(t.id, { fallbackReason: reason });
    if (settled) notify(settled, { swapInfo });
    return { success: true, trade: settled ?? getTrade(t.id), failed, swapInfo };
  } finally {
    unlockTrade(trade.id);
  }
}
