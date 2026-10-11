import config from "../config/index.js";
import log from "../core/logger.js";
import { getOpenPositions } from "../meteora/positions.js";
import { getTrackedPosition } from "../state/positions.js";
import {
  activateTrailing,
  updateTrailingAnchor,
  queueTrailingDrop,
  resolvePendingTrailingDrop,
  clearPendingTrailingDrop,
  trailingDropThreshold,
} from "../state/trailing.js";

const _trailingConfirmTimers = new Map();

export function scheduleTrailingConfirmation(pos, pairLabel, handleClose) {
  if (!pos?.position || _trailingConfirmTimers.has(pos.position)) return;

  const delaySec = Math.max(1, Number(config.trailingConfirmDelaySec) || 10);

  const timer = setTimeout(async () => {
    _trailingConfirmTimers.delete(pos.position);
    log.info(`${pairLabel}: ${delaySec}s recheck — fetching fresh PnL...`);

    try {
      const fresh = await getOpenPositions();
      if (!fresh || fresh.length === 0) return;
      const match = fresh.find((p) => p.position === pos.position);
      if (!match || match.pnlPct == null) return;

      const resolved = resolvePendingTrailingDrop(
        pos.position,
        match.pnlPct,
        config.rulesFor(pos.mode).trailingDropRatioPct,
        config.rulesFor(pos.mode).trailingDropPct
      );
      if (resolved.confirmed) {
        log.info(`${pairLabel}: trailing confirmed after ${delaySec}s — ${resolved.reason}`);
        await handleClose(match, resolved.reason);
      } else if (resolved.rejected) {
        log.info(`${pairLabel}: trailing drop rejected after ${delaySec}s (price recovered)`);
      }
    } catch (err) {
      log.warn(`${pairLabel}: ${delaySec}s trailing recheck failed: ${err.message}`);
    }
  }, delaySec * 1000);

  _trailingConfirmTimers.set(pos.position, timer);
}

export function clearTrailingTimer(positionAddress) {
  if (!positionAddress) return;
  const timer = _trailingConfirmTimers.get(positionAddress);
  if (timer) {
    clearTimeout(timer);
    _trailingConfirmTimers.delete(positionAddress);
  }
}

// Pilih referensi trailing (fungsi murni, tanpa side-effect).
// - Indikator armed  -> anchor pasca-sinyal (naik mengikuti PnL baru), abaikan lastPnlPeak.
// - Peak murni aktif -> lastPnlPeak, syarat peak >= trailingTriggerPct.
export function resolveTrailingReference(tracked, pnlPct, rules) {
  if (!tracked || pnlPct == null) return null;

  if (tracked.trailingArmedBy != null) {
    const base = tracked.trailingAnchor;
    const reference = base == null ? pnlPct : Math.max(base, pnlPct);
    return { reference, isIndicator: true };
  }

  if (!rules?.trailingTakeProfit) return null;
  const peak = tracked.lastPnlPeak;
  if (peak == null || peak < rules.trailingTriggerPct) return null;
  return { reference: peak, isIndicator: false };
}

// Trailing TP — 2-phase (meridian approach) — per-mode rules.
// Di-arm oleh peak >= trailingTriggerPct ATAU sinyal indikator (trailingArmedBy).
export function processTrailing(pos, tracked, pairLabel, handleClose) {
  const rulesForTrailing = config.rulesFor(pos.mode);
  if (pos.pnlPct == null) return;

  tracked = getTrackedPosition(pos.position);
  const resolved = resolveTrailingReference(tracked, pos.pnlPct, rulesForTrailing);
  if (!resolved) return;

  const { reference, isIndicator } = resolved;

  // Ambang drop = max(reference * ratio, floor) — adaptif untuk peak besar,
  // floor menjaga peak rendah dari exit karena noise.
  const dropThreshold = trailingDropThreshold(
    reference,
    rulesForTrailing.trailingDropRatioPct,
    rulesForTrailing.trailingDropPct
  );

  if (isIndicator) {
    updateTrailingAnchor(pos.position, pos.pnlPct);
    tracked = getTrackedPosition(pos.position);
  }

  if (!tracked?.trailingActive) {
    activateTrailing(pos.position);
    const activation = isIndicator
      ? `indicator ${tracked?.trailingArmedBy} @ ${reference.toFixed(2)}%`
      : `peak ${reference.toFixed(2)}% >= ${rulesForTrailing.trailingTriggerPct}%`;
    log.info(`${pairLabel}: trailing TP activated (${activation})`);
  }

  const drop = reference - pos.pnlPct;
  const pending = tracked?.pendingTrailingPeak != null;
  const confirmed = tracked?.confirmedTrailingExit != null;

  // Log status tiap cycle ketika trailing aktif
  if (tracked?.trailingActive && !confirmed) {
    log.info(
      `${pairLabel}: trailing active | ${isIndicator ? "anchor" : "peak"} ${reference.toFixed(2)}%, current ${pos.pnlPct.toFixed(2)}%, drop ${drop.toFixed(2)}%`
    );
  }

  // Re-activation: state stuck karena restart (trailingActive=true tapi pending/confirmed hilang)
  if (tracked?.trailingActive && !pending && !confirmed && drop >= dropThreshold) {
    queueTrailingDrop(pos.position, reference, pos.pnlPct);
    scheduleTrailingConfirmation(pos, pairLabel, handleClose);
    log.info(
      `${pairLabel}: trailing re-activation after restart (drop ${drop.toFixed(2)}% >= ${dropThreshold.toFixed(2)}%)`
    );
  } else if (drop >= dropThreshold) {
    if (!pending) {
      // Phase 1: queue pending drop + start confirmation timer
      queueTrailingDrop(pos.position, reference, pos.pnlPct);
      log.info(
        `${pairLabel}: trailing drop queued (${isIndicator ? "anchor" : "peak"} ${reference.toFixed(2)}% -> ${pos.pnlPct.toFixed(2)}%, drop ${drop.toFixed(2)}%)`
      );
      scheduleTrailingConfirmation(pos, pairLabel, handleClose);
    } else {
      // Safety net: cycle-based recheck (in case timer failed/overlapped)
      tracked = getTrackedPosition(pos.position);
      if (tracked) {
        const recheck = resolvePendingTrailingDrop(
          pos.position,
          pos.pnlPct,
          rulesForTrailing.trailingDropRatioPct,
          rulesForTrailing.trailingDropPct
        );
        if (recheck.confirmed) {
          log.info(`${pairLabel}: trailing drop confirmed after cycle recheck (safety net) — ${recheck.reason}`);
        }
      }
    }
  } else if (pending) {
    clearPendingTrailingDrop(pos.position);
    clearTrailingTimer(pos.position);
    log.info(`${pairLabel}: trailing drop recovered (drop ${drop.toFixed(2)}% < ${dropThreshold.toFixed(2)}%)`);
  }
}
