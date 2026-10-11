import config from "../config/index.js";
import { isOn } from "../state/settings.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { closePosition } from "../meteora/close.js";
import { waitClosedPositionPnl } from "../meteora/positions.js";
import { getTokenBalance } from "../solana/balances.js";
import { swapToSol } from "../solana/swap.js";
import { recordClose, getTrackedPosition, getOpenTrackedPositions } from "../state/positions.js";
import { clearTrailingState } from "../state/trailing.js";
import { clearBounceRecovery } from "../state/bounce.js";
import { clearDcaState, resetPoolDcaState, getPoolDcaCount, markPoolDcaCloseSafeguard, isTrailingTpReason } from "../state/dca.js";
import { clearTrailingTimer } from "./trailing.js";
import { addClosingPool, removeClosingPool, recordAction } from "../entry/runtime.js";
import { deactivatePool } from "../entry/index.js";
import { humanReason, fmtPct } from "../core/report.js";

// Guard per-posisi: cegah beberapa close paralel untuk posisi yang sama
// (timer konfirmasi trailing + safety-net siklus bisa memicu bersamaan).
const closingPositions = new Set();

export async function handleClose(pos, reason, opts = {}) {
  const { skipAutoSwap = false, skipDeactivate = false } = opts;
  const pairLabel = pos.pair || pos.position?.slice(0, 8) || "?";
  const positionAddress = pos.position;

  if (!positionAddress) return { success: false, error: "no position address" };

  if (closingPositions.has(positionAddress)) {
    log.info(`${pairLabel}: close already in progress — skip duplicate (${reason})`);
    return { success: false, skipped: true };
  }
  closingPositions.add(positionAddress);
  addClosingPool(pos.pool);

  try {
    const result = await closePosition(positionAddress);

    if (result?.success) {
      // PnL final dari endpoint closed Meteora (agar alert sama dengan dashboard).
      // Dijalankan paralel dengan swap; fallback ke PnL live bila belum ter-index.
      const realizedPnlPromise = result.dryRun ? Promise.resolve(null) : waitClosedPositionPnl(pos.pool, pos.position);
      // Ambil tracked sebelum clearTrailingState agar referensi trailing masih tersedia.
      const trackedClose = getTrackedPosition(pos.position);
      const wasDca = trackedClose?.isDca === true;
      const peakPnl = trackedClose?.lastPnlPeak ?? null;
      const lowestPnl = trackedClose?.lastPnlLowest ?? null;
      clearTrailingTimer(pos.position);
      clearTrailingState(pos.position);
      clearBounceRecovery(pos.position);
      clearDcaState(pos.position);

      // Posisi DCA ditutup: buka lagi kesempatan DCA berikutnya untuk posisi
      // sisa di pool (mis. posisi utama arm ulang untuk DCA#2 pada ambang lebih
      // dalam). Kuota sesi TIDAK dikembalikan — slot DCA yang sudah dipakai
      // hangus, total tetap dibatasi DCA_MAX_ADDS.
      if (wasDca) {
        resetPoolDcaState(pos.pool, pos.position);

        // Safeguard: DCA terakhir exit karena trailing TP → posisi asli ikut
        // ditutup (loop exit akan memprosesnya). Hanya saat kuota sesi sudah
        // habis dan tak ada DCA lain yang masih terbuka.
        if (isOn("dca") && config.dca.closeSafeguard && isTrailingTpReason(reason)) {
          const quotaReached = getPoolDcaCount(pos.pool) >= config.dca.maxAdds;
          const otherDcaOpen = getOpenTrackedPositions().some(
            (p) => p.pool === pos.pool && p.position !== pos.position && p.isDca === true
          );
          if (quotaReached && !otherDcaOpen) {
            const marked = markPoolDcaCloseSafeguard(pos.pool, pos.position);
            if (marked > 0) {
              log.info(`${pairLabel}: DCA terakhir profit (trailing TP) — safeguard menutup ${marked} posisi asli`);
            }
          }
        }
      }

      // Auto-swap base token to SOL (Jupiter V2, with retries)
      let swapInfo = null;
      if (!skipAutoSwap && config.swap.autoSwapAfterClose && result.baseMint) {
        const balance = await getTokenBalance(result.baseMint);
        if (balance > 0) {
          const swapResult = await swapToSol(result.baseMint, balance);
          swapInfo = {
            mint: result.baseMint.slice(0, 8),
            success: swapResult?.success === true,
            error: swapResult?.success ? null : String(swapResult?.error || "unknown").split("\n")[0],
          };
          if (swapResult?.success) {
            log.debug(`[detail] swap ${pairLabel} proceeds → SOL`);
          } else {
            log.warn(`Swap failed for ${pairLabel}: ${swapResult?.error}`);
          }
        }
      }

      const finalPnl = await realizedPnlPromise;
      const realizedPnl = finalPnl ?? pos.pnlPct;
      if (finalPnl == null) log.warn(`${pairLabel}: PnL final Meteora belum tersedia — pakai PnL live`);
      recordClose(pos.position, reason, realizedPnl);

      const swapTxt = swapInfo ? (swapInfo.success ? "token di-swap ke SOL" : "token GAGAL di-swap") : "tanpa swap";
      log.info(`🔒 CLOSE ${pairLabel} — ${humanReason(reason)} | PnL ${fmtPct(realizedPnl)} | ${swapTxt}`);
      log.debug(`[detail] reason=${reason} | position ${positionAddress} | peakRef=${peakPnl ?? "-"}`);
      recordAction(`CLOSE ${pairLabel} — ${humanReason(reason)} | PnL ${fmtPct(realizedPnl)}`);

      tg.notifyClose(pairLabel, reason, realizedPnl, swapInfo, lowestPnl, peakPnl);

      // Sesi pool selesai (tak ada posisi tersisa, termasuk DCA) → tandai '#'
      // di pool.txt agar tidak di-entry lagi tanpa pengawasan manual.
      const stillOpenInPool = getOpenTrackedPositions().some((p) => p.pool === pos.pool);
      if (!skipDeactivate && !stillOpenInPool) deactivatePool(pos.pool, "entry+exit selesai");
      return { success: true, swapInfo };
    } else {
      const brief = String(result?.error || "unknown").split("\n")[0];
      log.error(`Close failed for ${pairLabel}: ${brief}`);
      tg.notifyError(`Close failed ${pairLabel}: ${brief}`);
      return { success: false, error: result?.error || "unknown" };
    }
  } catch (err) {
    const brief = String(err.message || err).split("\n")[0];
    log.error(`Close error for ${pairLabel}: ${brief}`);
    tg.notifyError(`Close error ${pairLabel}: ${brief}`);
    return { success: false, error: err.message };
  } finally {
    closingPositions.delete(positionAddress);
    removeClosingPool(pos.pool);
  }
}
