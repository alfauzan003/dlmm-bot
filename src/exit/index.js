import config from "../config/index.js";
import log from "../core/logger.js";
import { sleep, minutes } from "../core/utils.js";
import { getOpenPositions } from "../meteora/positions.js";
import { fetchCandles, fetchVolume } from "../market/candles.js";
import { getTokenBalance } from "../solana/balances.js";
import { swapToSol } from "../solana/swap.js";
import * as tg from "../notify/telegram.js";
import {
  trackPosition,
  updatePnlPeaks,
  getTrackedPosition,
  updateCollectFeeMode,
  updateTrackedMode,
  recordTrackedRange,
  getOpenTrackedPositions,
  registerMissedCycle,
  resetMissedCycle,
  markClosedNotDetected,
} from "../state/positions.js";
import { recordPnlSnapshot } from "../state/history.js";
import { armIndicatorTrailing, clearTrailingState } from "../state/trailing.js";
import { evaluateExit, isExitWarmup } from "./rules.js";
import { classifyMode, isCompositeMode } from "./classify.js";
import { processTrailing, clearTrailingTimer } from "./trailing.js";
import { processBounceRecovery } from "./bounce.js";
import { clearBounceRecovery } from "../state/bounce.js";
import { clearDcaState, resetStaleDcaPools, getPoolDcaCount, effectiveDcaArmPct } from "../state/dca.js";
import { getEntryInProgressPools, getClosingPools, takeRecentActions } from "../entry/runtime.js";
import { getWatchSnapshot, deactivatePool } from "../entry/index.js";
import { buildSummaryBlock, humanReason, fmtPct } from "../core/report.js";
import { runSafetySweep } from "./sweep.js";
import { handleClose } from "./close.js";
import { handleSpotOorKiri } from "./spot-fallback.js";
import { handleSpotOorKananReentry, canSpotReenter } from "./spot-reentry.js";

let cycleCount = 0;
let lastStatusSent = 0;
let lastSummaryAt = 0;

// Best-effort: saat posisi dianggap ditutup manual, coba swap sisa token ke SOL.
// Kalau tidak ada saldo atau gagal, abaikan (safety sweep per-siklus tetap jalan).
function sweepClosedPosition(baseMint, label) {
  if (!baseMint) return;
  getTokenBalance(baseMint)
    .then((balance) => (balance > 0 ? swapToSol(baseMint, balance) : null))
    .catch((err) => log.warn(`${label}: best-effort swap gagal: ${err.message}`));
}

// Posisi yang tidak lagi terbaca on-chain selama `missingCycleThreshold`
// siklus berturut-turut dianggap sudah ditutup manual: tandai closed,
// bersihkan state trailing/bounce, lalu kirim alert Telegram sekali.
function handleMissingPositions(seen) {
  const threshold = config.missingCycleThreshold;
  for (const p of getOpenTrackedPositions()) {
    if (p.position && seen.has(p.position)) {
      resetMissedCycle(p.position);
      continue;
    }
    const short = p.position ? p.position.slice(0, 8) : "?";
    const label = p.pair || short;
    const count = registerMissedCycle(p.position);
    if (count < threshold) {
      log.warn(`${label}: position tidak terbaca (${count}/${threshold})`);
      continue;
    }
    markClosedNotDetected(p.position);
    clearTrailingTimer(p.position);
    clearTrailingState(p.position);
    clearBounceRecovery(p.position);
    clearDcaState(p.position);
    log.warn(`${label}: position tidak terbaca ${count} cycle — dianggap ditutup manual`);
    tg.notifyPositionMissing(p.position, p.pair, count);
    sweepClosedPosition(p.baseMint, label);
    if (!getOpenTrackedPositions().some((t) => t.pool === p.pool)) {
      deactivatePool(p.pool, "posisi ditutup manual / hilang");
    }
  }
}

// --- Ringkasan naratif untuk log PM2 ---

function buildPositionLines(positions) {
  return positions.map((pos) => {
    const tracked = getTrackedPosition(pos.position);
    let zone = null;
    if (pos.activeBin != null && pos.lowerBin != null && pos.upperBin != null) {
      zone =
        pos.activeBin > pos.upperBin
          ? "di atas rentang"
          : pos.activeBin < pos.lowerBin
            ? "di bawah rentang"
            : "masih dalam rentang";
    }
    let trailing = null;
    if (tracked?.trailingActive) {
      const ref = tracked.trailingArmedBy != null ? tracked.trailingAnchor : tracked.lastPnlPeak;
      trailing = ref != null ? `trailing aktif (acuan ${fmtPct(ref)})` : "trailing aktif";
    }
    return { pair: pos.pair, position: pos.position, pnlPct: pos.pnlPct, zone, trailing };
  });
}

function buildDcaLines(positions) {
  const byPool = new Map();
  for (const pos of positions) {
    const tracked = getTrackedPosition(pos.position);
    if (!tracked) continue;
    if (!byPool.has(pos.pool)) byPool.set(pos.pool, []);
    byPool.get(pos.pool).push(tracked);
  }

  const lines = [];
  for (const [pool, list] of byPool) {
    const name = list[0].pair || `${pool.slice(0, 8)}…`;
    const pending = list.find((t) => t.pendingDcaTrough != null);
    const triggered = list.find((t) => t.dcaTriggered);
    const armed = list.find((t) => t.dcaArmed && !t.dcaTriggered);
    const count = getPoolDcaCount(pool);
    const dcaOpen = list.some((t) => t.isDca === true);
    const armPct = effectiveDcaArmPct(count, dcaOpen, config.dca);

    if (triggered) {
      lines.push(`${name} : sudah DCA (${count}/${config.dca.maxAdds} sesi ini)`);
    } else if (pending) {
      lines.push(`${name} : menunggu konfirmasi pantulan dari titik terendah ${fmtPct(pending.pendingDcaTrough)}`);
    } else if (armed) {
      lines.push(
        `${name} : sudah di-arm, titik terendah ${fmtPct(armed.dcaTrough)}, menunggu pantulan +${config.dca.reboundPct}pt`
      );
    } else {
      lines.push(`${name} : belum menyentuh ${armPct}%`);
    }
  }
  return lines;
}

function emitSummary(positions) {
  const now = Date.now();
  const intervalMs = minutes(config.tgStatusInterval);
  if (lastSummaryAt !== 0 && now - lastSummaryAt < intervalMs) return;
  lastSummaryAt = now;

  const block = buildSummaryBlock({
    mode: config.dryRun ? "DRY RUN" : "LIVE",
    now,
    watched: getWatchSnapshot(),
    positions: buildPositionLines(positions),
    dcaLines: config.dca.enabled ? buildDcaLines(positions) : ["fitur DCA nonaktif"],
    actionLines: takeRecentActions(intervalMs),
  });
  log.info("\n" + block);
}

export async function mainLoop() {
  // Tunda ringkasan pertama ~20s agar refresh kandidat pool sudah selesai.
  lastSummaryAt = Date.now() - minutes(config.tgStatusInterval) + 20_000;

  while (true) {
    cycleCount++;
    log.debug(`[detail] exit cycle #${cycleCount}`);

    await runSafetySweep();

    let positions;
    try {
      positions = await getOpenPositions();
    } catch (err) {
      log.error(`Failed to fetch positions: ${err.message}`);
      await sleep(minutes(config.pollIntervalHold));
      continue;
    }

    // null = fetch gagal; jangan hitung sebagai posisi hilang.
    if (positions == null) {
      log.error("Failed to fetch positions (null) — skip missing-position check");
      await sleep(minutes(config.pollIntervalHold));
      continue;
    }

    handleMissingPositions(new Set(positions.map((p) => p.position).filter(Boolean)));

    // Sesi DCA per pool: reset counter untuk pool yang tidak lagi punya posisi
    // aktif (termasuk in-flight & yang sedang closing).
    const activePools = new Set(positions.map((p) => p.pool).filter(Boolean));
    for (const pool of getEntryInProgressPools()) activePools.add(pool);
    for (const pool of getClosingPools()) activePools.add(pool);
    resetStaleDcaPools(activePools);

    if (positions.length === 0) {
      emitSummary([]);
      const pending = getOpenTrackedPositions().length;
      if (pending === 0) {
        log.debug(`[detail] tidak ada posisi — idle ${config.pollIntervalIdle}m`);
        await sleep(minutes(config.pollIntervalIdle));
      } else {
        log.debug(`[detail] ${pending} posisi ter-track belum terbaca — recheck ${config.pollIntervalHold}m`);
        await sleep(minutes(config.pollIntervalHold));
      }
      continue;
    }

    log.debug(`[detail] ${positions.length} posisi terbuka — cek tiap ${Math.round(config.pollIntervalHold * 60)}s`);

    for (const pos of positions) {
      if (!pos.position) {
        log.warn("Skipping position with no address");
        continue;
      }

      const shortAddr = pos.position.slice(0, 8);
      const pairLabel = pos.pair || shortAddr;

      // Track position on first seen
      let tracked = getTrackedPosition(pos.position);
      if (!tracked) {
        const mode = classifyMode(pos);
        trackPosition(pos.position, pos.pool, pos.pair, pos.baseMint, pos.collectFeeMode, mode);
        tracked = getTrackedPosition(pos.position);
        log.debug(
          `[detail] ${pairLabel}: mode=${tracked?.mode || mode} (entry base=${pos.entryBaseAmount ?? "?"} sol=${pos.entrySolAmount ?? "?"} span=${pos.binSpan})`
        );
      } else {
        updateCollectFeeMode(pos.position, pos.collectFeeMode);
        // Perbaiki mode legacy/invalid (mis. angka 0/1 sisa bug argumen) dengan
        // mereklasifikasi dari data posisi on-chain.
        if (!isCompositeMode(tracked.mode)) {
          const repaired = classifyMode(pos);
          updateTrackedMode(pos.position, repaired);
          log.warn(`${pairLabel}: mode invalid ${JSON.stringify(tracked.mode)} → diperbaiki ke ${repaired}`);
          tracked = getTrackedPosition(pos.position);
        }
      }
      pos.mode = tracked?.mode ?? "spot";
      pos.ageMinutes = Math.floor((Date.now() - (tracked?.firstSeenAt || Date.now())) / 60000);

      // Catat range bin sekali untuk posisi spot (lower/upper/span).
      if (pos.mode === "spot") {
        recordTrackedRange(pos.position, pos.lowerBin, pos.upperBin);
      }

      // Track PnL peaks
      if (pos.pnlPct != null) updatePnlPeaks(pos.position, pos.pnlPct);

      // Snapshot PnL history + volume for evaluation
      if (pos.pnlPct != null) {
        const volumeData = pos.baseMint
          ? await fetchVolume(pos.baseMint, pos.pool, {
              resolution: config.volumeTimeframe,
              limit: config.volumeCandleCount,
            })
          : null;
        if (volumeData) pos.volume5m = volumeData.vol;
        recordPnlSnapshot(pos.position, pairLabel, pos.pnlPct, pos.marketCap, pos.feePct24h, volumeData);
      }

      // Safeguard: posisi asli ditandai agar ikut close setelah DCA terakhir
      // exit karena trailing TP (lihat exit/close.js).
      if (config.dca.enabled && tracked?.dcaCloseSafeguard) {
        await handleClose(pos, "dca_close_safeguard");
        continue;
      }

      // Evaluasi exit by mode. Warmup (khusus mode yang diatur): tahan trailing
      // & arm indikator beberapa menit pertama; stop loss/OOR/yield tetap jalan.
      const rules = config.rulesFor(pos.mode);
      const warmup = isExitWarmup(tracked?.firstSeenAt, rules.exitWarmupMinutes);

      // Trailing TP + bounce recovery state machines
      if (!warmup) processTrailing(pos, tracked, pairLabel, handleClose);
      processBounceRecovery(pos, pairLabel);

      let exit = evaluateExit(pos, null, { warmup });
      if (exit.action === "hold" && rules.enableIndicators && pos.baseMint && !warmup) {
        const candles = await fetchCandles(pos.baseMint, pos.pool);
        exit = evaluateExit(pos, candles, { warmup });
      }

      log.debug(
        `[detail] ${pairLabel}: ${exit.reason}${exit.action === "close" ? " → CLOSE" : ""}${warmup ? " [warmup]" : ""}`
      );

      if (exit.action === "close") {
        // OOR kiri spot: fallback konversi ke posisi token-only (close tanpa swap).
        let handled = false;
        if (exit.reason === "oor_kiri" && pos.mode === "spot") {
          handled = await handleSpotOorKiri(pos);
        }
        // OOR kanan spot: rencanakan re-entry sebelum close supaya pool tidak
        // ditandai '#' saat kita mau langsung membuka posisi lagi.
        const willReenter = !handled && canSpotReenter(pos, exit.reason);
        if (!handled) {
          const closeRes = await handleClose(pos, exit.reason, { skipDeactivate: willReenter });
          if (closeRes?.success && willReenter) await handleSpotOorKananReentry(pos);
        }
      } else if (exit.action === "arm_indicator_trailing") {
        armIndicatorTrailing(pos.position, exit.reason, pos.pnlPct);
        log.info(`${pairLabel}: ${humanReason(exit.reason)} → trailing profit disiapkan`);
      }
    }

    emitSummary(positions);

    if (lastStatusSent === 0 || Date.now() - lastStatusSent >= minutes(config.tgStatusInterval)) {
      await Promise.all(
        positions.map(async (pos) => {
          if (!pos.baseMint) return;
          const [c1m, c1h] = await Promise.all([
            fetchCandles(pos.baseMint, pos.pool, { resolution: "5m", limit: 2 }),
            fetchCandles(pos.baseMint, pos.pool, { resolution: "1h", limit: 2 }),
          ]);
          if (c1m && c1m.length >= 2) pos.volume1m = c1m[c1m.length - 2]?.volume || 0;
          if (c1h && c1h.length >= 2) pos.volume1h = c1h[c1h.length - 2]?.volume || 0;
        })
      );
      tg.notifyStatus(positions);
      lastStatusSent = Date.now();
    }

    await sleep(minutes(config.pollIntervalHold));
  }
}
