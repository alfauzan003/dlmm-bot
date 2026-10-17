import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { closePosition } from "../meteora/close.js";
import { waitClosedPositionEntry, pnlFromEntry, usdPnlFromEntry } from "../meteora/positions.js";
import { getTokenBalance } from "../solana/balances.js";
import { swapToSol } from "../solana/swap.js";
import { recordClose, getTrackedPosition, getOpenTrackedPositions } from "../state/positions.js";
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
    const result = await (deps.closePosition ?? closePosition)(positionAddress);

    if (result?.success) {
      // PnL final dari endpoint closed Meteora (agar alert sama dengan dashboard).
      // Dijalankan paralel dengan swap; fallback ke PnL live bila belum ter-index.
      const closedEntryPromise = result.dryRun
        ? Promise.resolve(null)
        : waitClosedPositionEntry(pos.pool, pos.position);
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

      const closedEntry = await closedEntryPromise;
      const finalPnl = pnlFromEntry(closedEntry);
      const realizedPnl = finalPnl ?? pos.pnlPct;
      if (finalPnl == null) log.warn(`${pairLabel}: PnL final Meteora belum tersedia — pakai PnL live`);
      // PnL USD final dari entri closed; fallback ke PnL USD live posisi.
      const finalUsd = usdPnlFromEntry(closedEntry).pnlUsd;
      const livePnlUsd = Number.isFinite(pos.pnlUsd) ? pos.pnlUsd : null;
      const pnlUsd = Number.isFinite(finalUsd) ? finalUsd : livePnlUsd;
      const closeTx = result.txs?.at(-1) ?? null;
      recordClose(pos.position, reason, realizedPnl, { pnlUsd, closeTx });

      const swapTxt = swapInfo ? (swapInfo.success ? "token di-swap ke SOL" : "token GAGAL di-swap") : "tanpa swap";
      log.info(`🔒 CLOSE ${pairLabel} — ${humanReason(reason)} | PnL ${fmtPct(realizedPnl)} | ${swapTxt}`);
      log.debug(`[detail] reason=${reason} | position ${positionAddress} | peakRef=${peakPnl ?? "-"}`);
      recordAction(`CLOSE ${pairLabel} — ${humanReason(reason)} | PnL ${fmtPct(realizedPnl)}`);

      if (!silent) tg.notifyClose(pairLabel, reason, realizedPnl, swapInfo, lowestPnl, peakPnl, { closeTx });

      // Sesi pool selesai (tak ada posisi tersisa) → tandai '#'
      // di pool.txt agar tidak di-entry lagi tanpa pengawasan manual.
      const stillOpenInPool = getOpenTrackedPositions().some((p) => p.pool === pos.pool);
      if (!skipDeactivate && !stillOpenInPool) deactivatePool(pos.pool, "entry+exit selesai");
      return { success: true, swapInfo, closeTx, pnlUsd, pnlPct: realizedPnl };
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
