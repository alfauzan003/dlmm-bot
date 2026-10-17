import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { closePosition } from "../meteora/close.js";
import { waitClosedPositionEntry, pnlFromEntry, usdPnlFromEntry } from "../meteora/positions.js";
import { getTokenBalance } from "../solana/balances.js";
import { swapToSol } from "../solana/swap.js";
import { recordClose, updateClosePnl, getTrackedPosition, getOpenTrackedPositions } from "../state/positions.js";
import { addClosingPool, removeClosingPool, recordAction } from "../entry/runtime.js";
import { removeKeepMint } from "../state/keep-mints.js";
import { deactivatePool } from "../entry/index.js";
import { humanReason, fmtPct } from "../core/report.js";

// Guard per-posisi: cegah beberapa close paralel untuk posisi yang sama.
const closingPositions = new Set();

export async function handleClose(pos, reason, opts = {}) {
  const { skipAutoSwap = false, skipDeactivate = false, silent = false, deps = {} } = opts;
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
    const result = await (deps.closePosition ?? closePosition)(positionAddress, { poolAddress: pos.pool });

    if (result?.success) {
      // PnL final dari endpoint closed Meteora (agar sama dengan dashboard). Tidak ditunggu:
      // close dicatat + alert dikirim dengan PnL live, lalu diperbarui saat entri ter-index.
      const closedEntryPromise = result.dryRun
        ? Promise.resolve(null)
        : (deps.waitClosedPositionEntry ?? waitClosedPositionEntry)(pos.pool, pos.position);
      const trackedClose = getTrackedPosition(pos.position);
      const peakPnl = trackedClose?.lastPnlPeak ?? null;
      const lowestPnl = trackedClose?.lastPnlLowest ?? null;

      // Auto-swap base token to SOL (Jupiter V2, with retries)
      let swapInfo = null;
      if (!skipAutoSwap && config.swap.autoSwapAfterClose && result.baseMint) {
        const balance = await (deps.getTokenBalance ?? getTokenBalance)(result.baseMint);
        if (balance > 0) {
          const swapResult = await (deps.swapToSol ?? swapToSol)(result.baseMint, balance);
          swapInfo = {
            mint: result.baseMint.slice(0, 8),
            success: swapResult?.success === true,
            error: swapResult?.success ? null : String(swapResult?.error || "unknown").split("\n")[0],
          };
          if (swapResult?.success) {
            // Token sudah dijual: jangan lagi dikecualikan dari safety sweep.
            removeKeepMint(result.baseMint);
            log.debug(`[detail] swap ${pairLabel} proceeds → SOL`);
          } else {
            log.warn(`Swap failed for ${pairLabel}: ${swapResult?.error}`);
          }
        }
      }

      const realizedPnl = pos.pnlPct;
      const pnlUsd = Number.isFinite(pos.pnlUsd) ? pos.pnlUsd : null;
      const closeTx = result.txs?.at(-1) ?? null;
      recordClose(pos.position, reason, realizedPnl, { pnlUsd, closeTx });

      const swapTxt = swapInfo ? (swapInfo.success ? "token di-swap ke SOL" : "token GAGAL di-swap") : "tanpa swap";
      log.info(`🔒 CLOSE ${pairLabel} — ${humanReason(reason)} | PnL live ${fmtPct(realizedPnl)} | ${swapTxt}`);
      log.debug(`[detail] reason=${reason} | position ${positionAddress} | peakRef=${peakPnl ?? "-"}`);
      recordAction(`CLOSE ${pairLabel} — ${humanReason(reason)} | PnL ${fmtPct(realizedPnl)}`);

      const notify = deps.notifyClose ?? tg.notifyClose;
      const msgIdPromise = silent
        ? null
        : Promise.resolve(notify(pairLabel, reason, realizedPnl, swapInfo, lowestPnl, peakPnl, { closeTx }));

      // Latar belakang: PnL final Meteora menggantikan PnL live di state + alert. Tidak pernah reject.
      const finalPnl = closedEntryPromise
        .then(async (closedEntry) => {
          const pnlPct = pnlFromEntry(closedEntry);
          if (pnlPct == null) {
            log.warn(`${pairLabel}: PnL final Meteora belum tersedia — tetap pakai PnL live`);
            return null;
          }
          const finalUsd = usdPnlFromEntry(closedEntry).pnlUsd;
          const final = { pnlPct, pnlUsd: Number.isFinite(finalUsd) ? finalUsd : pnlUsd };
          updateClosePnl(pos.position, final);
          log.info(`${pairLabel}: PnL final Meteora ${fmtPct(pnlPct)} (live ${fmtPct(realizedPnl)})`);
          const editMessageId = await msgIdPromise;
          if (editMessageId && pnlPct !== realizedPnl) {
            await notify(pairLabel, reason, pnlPct, swapInfo, lowestPnl, peakPnl, { closeTx, editMessageId });
          }
          return final;
        })
        .catch((err) => {
          log.warn(`${pairLabel}: update PnL final gagal: ${err.message}`);
          return null;
        });

      // Sesi pool selesai (tak ada posisi tersisa) → tandai '#'
      // di pool.txt agar tidak di-entry lagi tanpa pengawasan manual.
      const stillOpenInPool = getOpenTrackedPositions().some((p) => p.pool === pos.pool);
      if (!skipDeactivate && !stillOpenInPool) deactivatePool(pos.pool, "entry+exit selesai");
      return { success: true, swapInfo, closeTx, pnlUsd, pnlPct: realizedPnl, finalPnl };
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
