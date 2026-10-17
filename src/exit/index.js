import config from "../config/index.js";
import log from "../core/logger.js";
import { sleep, minutes } from "../core/utils.js";
import { getOpenPositions } from "../meteora/positions.js";
import { fetchCandles, fetchVolume } from "../market/candles.js";
import * as tg from "../notify/telegram.js";
import {
  trackPosition,
  updatePnlPeaks,
  getTrackedPosition,
  updateCollectFeeMode,
  updateTrackedMode,
  getOpenTrackedPositions,
  registerMissedCycle,
  resetMissedCycle,
  markClosedNotDetected,
} from "../state/positions.js";
import { recordPnlSnapshot } from "../state/history.js";
import { classifyMode, isCompositeMode } from "./classify.js";
import { takeRecentActions } from "../entry/runtime.js";
import { getWatchSnapshot, deactivatePool } from "../entry/index.js";
import { buildSummaryBlock } from "../core/report.js";
import { runSafetySweep, sweepClosedPosition } from "./sweep.js";
import { runAutoFlips } from "./auto-flip.js";
import { syncTrades, setLivePositions, settleTradesForPositions, settleOpenTrades } from "./trade-loop.js";

let cycleCount = 0;
let lastStatusSent = 0;
let lastSummaryAt = 0;

// Posisi yang tidak lagi terbaca on-chain selama `missingCycleThreshold`
// siklus berturut-turut dianggap sudah ditutup manual: tandai closed,
// lalu kirim alert Telegram sekali.
function handleMissingPositions(seen) {
  const threshold = config.missingCycleThreshold;
  const marked = [];
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
    marked.push(p.position);
    log.warn(`${label}: position tidak terbaca ${count} cycle — dianggap ditutup manual`);
    tg.notifyPositionMissing(p.position, p.pair, count);
    sweepClosedPosition(p.baseMint, label);
    if (!getOpenTrackedPositions().some((t) => t.pool === p.pool)) {
      deactivatePool(p.pool, "posisi ditutup manual / hilang");
    }
  }
  return marked;
}

// --- Ringkasan naratif untuk log PM2 ---

function buildPositionLines(positions) {
  return positions.map((pos) => {
    let zone = null;
    if (pos.activeBin != null && pos.lowerBin != null && pos.upperBin != null) {
      zone =
        pos.activeBin > pos.upperBin
          ? "di atas rentang"
          : pos.activeBin < pos.lowerBin
            ? "di bawah rentang"
            : "masih dalam rentang";
    }
    return { pair: pos.pair, position: pos.position, pnlPct: pos.pnlPct, zone };
  });
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

    const missing = handleMissingPositions(new Set(positions.map((p) => p.position).filter(Boolean)));
    // Trade yang semua leg-nya kini tertutup → selesai (closed_outside).
    settleTradesForPositions(missing);

    if (positions.length === 0) {
      setLivePositions([]);
      // Leg terakhir bisa tertutup tick lalu: selesaikan trade-nya sekarang.
      settleOpenTrades();
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

    // Posisi yang sudah di-track bot sebelum tick ini (adopsi trade: auto vs external).
    const wasTracked = new Set(positions.map((p) => p.position).filter((addr) => addr && getTrackedPosition(addr)));

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
    }

    // Trade: adopsi posisi baru. TP/SL/Trail jalan di loop cepat sendiri (tradeExitLoop)
    // memakai snapshot posisi ini.
    syncTrades(positions, { wasTracked });
    setLivePositions(positions);
    // Auto flip per trade (bin aktif dari snapshot ini; tanpa RPC tambahan sampai ambang tercapai).
    try {
      await runAutoFlips(positions);
    } catch (err) {
      log.error(`Auto flip error: ${err.message}`);
    }

    for (const pos of positions) {
      if (!pos.position) continue;
      const pairLabel = pos.pair || pos.position.slice(0, 8);

      // Track PnL peaks
      if (pos.pnlPct != null) updatePnlPeaks(pos.position, pos.pnlPct);

      // Snapshot PnL history + volume
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
