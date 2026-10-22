import log from "../core/logger.js";
import { handleClose } from "../exit/close.js";
import { notifyTradeClosed } from "../notify/telegram.js";
import { addKeepMint, removeKeepMint } from "../state/keep-mints.js";
import { getTrackedPosition } from "../state/positions.js";
import { getTrade, refreshTradePnl, settleTradeIfDone, tryLockTrade, unlockTrade } from "../state/trades.js";
import { swapBaseToSol } from "./claim.js";

// Tunggu PnL final leg, hitung ulang PnL trade, lalu edit alert bila berubah. Tidak pernah reject.
async function refreshAlert(settled, finals, msgId, { swapInfo, notify }) {
  try {
    const results = await Promise.all(finals);
    if (results.every((r) => r == null)) return null;
    const fresh = refreshTradePnl(settled.id);
    if (!fresh) return null;
    const editMessageId = await msgId;
    const changed = fresh.closePnlUsd !== settled.closePnlUsd || fresh.closePnlPct !== settled.closePnlPct;
    if (editMessageId && changed) await notify(fresh, { swapInfo, editMessageId });
    return fresh;
  } catch (err) {
    log.warn(`closeTrade #${settled.id}: update PnL final gagal: ${err.message}`);
    return null;
  }
}

// Tutup semua leg satu trade (tanpa alert per-leg), swap base token sekali,
// lalu selesaikan trade dan kirim satu alert. Leg yang gagal membuat trade
// tetap terbuka (bisa dicoba lagi); leg yang sudah tertutup dilewati.
// detail (opsional) = penjelasan alasan close, disimpan di trade.closeDetail dan tampil di alert.
export async function closeTrade(
  trade,
  { reason, detail = null, swap = true, positionsByAddr = new Map(), deps = {} } = {}
) {
  const close = deps.handleClose ?? handleClose;
  const notify = deps.notifyTradeClosed ?? notifyTradeClosed;

  if (!tryLockTrade(trade.id, "close")) return { success: false, busy: true, failed: [], swapInfo: null };

  try {
    const t = getTrade(trade.id) ?? trade;
    if (t.closed === true) return { success: true, trade: t, failed: [], swapInfo: null };

    let closedNow = 0;
    const failed = [];
    const finals = [];
    for (const addr of t.positions) {
      if (getTrackedPosition(addr)?.closed === true) continue;
      const pos = positionsByAddr.get(addr) ?? { position: addr, pool: t.pool, pair: t.pair, baseMint: t.baseMint };
      try {
        const opts = { skipAutoSwap: true, silent: true };
        const res = await close(pos, reason, opts);
        if (res?.success) {
          closedNow++;
          if (res.finalPnl) finals.push(res.finalPnl);
        } else failed.push(addr);
      } catch (err) {
        failed.push(addr);
        log.warn(`closeTrade #${t.id}: leg ${addr.slice(0, 8)} error: ${err.message}`);
      }
    }

    // Token dari leg yang sudah tertutup di-swap sekali, walau ada leg lain yang gagal.
    const swapInfo = swap && closedNow > 0 ? await swapBaseToSol(t.baseMint, deps) : null;
    // Close only: token sengaja disimpan pengguna -> jangan dijual safety sweep.
    if (closedNow > 0) (swap ? removeKeepMint : addKeepMint)(t.baseMint);

    if (failed.length > 0) {
      log.warn(`closeTrade #${t.id}: ${failed.length} leg gagal — trade tetap terbuka`);
      return { success: false, trade: getTrade(t.id), failed, swapInfo };
    }

    const settled = settleTradeIfDone(t.id, { fallbackReason: reason, closeDetail: detail });
    const msgId = settled ? Promise.resolve(notify(settled, { swapInfo })) : null;
    // Alert di atas memakai PnL live; perbarui setelah PnL final Meteora semua leg masuk (latar belakang).
    const finalPnl = settled && finals.length > 0 ? refreshAlert(settled, finals, msgId, { swapInfo, notify }) : null;
    return { success: true, trade: settled ?? getTrade(t.id), failed, swapInfo, finalPnl };
  } finally {
    unlockTrade(trade.id);
  }
}
