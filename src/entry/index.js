import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { countOpenBotPositionsByPool } from "../state/positions.js";
import { loadPoolList, commentPoolInList } from "./pool-list.js";
import { getPoolInfo, pairNameCache } from "./pool-info.js";
import { watchPrices, getLastPrices } from "./price-watch.js";
import { getSupertrend, getSupertrendFallback } from "../market/supertrend-state.js";
import { executeEntry } from "./execute.js";
import { selectWatchCandidates } from "./candidates.js";
import {
  addEntryInProgressMint,
  removeEntryInProgressMint,
  getEntryUsage,
  getEntryInProgressPools,
} from "./runtime.js";

export { getPoolNames } from "./pool-info.js";
export { selectWatchCandidates } from "./candidates.js";

// Ringkasan pool yang sedang dipantau untuk log naratif (tanpa I/O).
export function getWatchSnapshot() {
  const prices = getLastPrices();
  return candidateCache.map((c) => {
    const st = getSupertrend(c.mint) || getSupertrendFallback(c.mint);
    const price = prices.get(c.mint);
    return {
      pool: c.pool,
      pairName: c.pairName || pairNameCache.get(c.pool) || null,
      mint: c.mint,
      sizeSol: c.sizeSol,
      trend: st ? st.direction : null,
      line: st ? st.line : null,
      price: Number.isFinite(price) ? price : null,
    };
  });
}

// Runtime-only state (resets on restart, as designed)
const firstSeenAt = new Map();
const skipped = new Set();
const dryRunNoted = new Set();
const failureCooldownUntil = new Map();
const failureCounts = new Map();
// Mode entry yang selalu dibuka bot (lihat execute.js) — dipakai untuk kuota
// posisi serentak per mode.
const ENTRY_MODE = "bidask:double";
// Dibagi dengan DCA agar entry sinyal & DCA tidak bentrok di pool yang sama.
const inFlightPools = getEntryInProgressPools();
const enteredPools = new Map(); // pool -> enteredAt (posisi baru dibuka / masih terbuka)

// Kandidat dari refresh lambat; dibaca oleh poll harga cepat.
let candidateCache = [];
let _refreshBusy = false;
let _watchBusy = false;

// Matikan pool secara persisten: beri `#` di pool.txt + hentikan pemantauan
// in-process seketika (poll harga cepat tidak mengecek `skipped`). Hapus `#`
// secara manual untuk mengaktifkan kembali.
export function deactivatePool(pool, reason) {
  if (!pool) return;
  // Dry run tidak boleh mengubah pool.txt; cukup skip runtime.
  if (config.dryRun) {
    skipped.add(pool);
    return;
  }
  candidateCache = candidateCache.filter((c) => c.pool !== pool);
  failureCounts.delete(pool);
  failureCooldownUntil.delete(pool);
  dryRunNoted.delete(pool);
  if (commentPoolInList(pool)) {
    skipped.delete(pool);
    log.info(
      `Pool ${pool.slice(0, 8)} ditandai '#' di ${config.entry.poolListFile}${reason ? ` (${reason})` : ""} — hapus '#' untuk memantau lagi`
    );
  } else {
    skipped.add(pool);
    log.warn(`Pool ${pool.slice(0, 8)} gagal ditandai di ${config.entry.poolListFile} — skip sampai restart`);
  }
}

// Refresh lambat: pool list, expiry, kuota serentak (dari state), dan pool info.
// Hanya fungsi ini yang menyentuh RPC, sehingga aman dijalankan sesekali.
export async function refreshCandidates() {
  if (!config.entry.enabled) return null;
  if (_refreshBusy) return null;
  _refreshBusy = true;
  const refreshStartedAt = Date.now();

  try {
    const pools = loadPoolList();
    if (pools.length === 0) {
      candidateCache = [];
      return null;
    }

    // Kuota serentak dihitung dari posisi bidask:double MILIK BOT (state),
    // bukan hitungan on-chain, agar posisi mode lain (mis. spot manual) tidak
    // memblokir entry.
    const openBotByPool = countOpenBotPositionsByPool(ENTRY_MODE);
    const now = Date.now();
    const candidates = [];
    const stillOpen = new Set();

    for (const { pool: poolAddress, sizeSol, maxPositions } of pools) {
      if (skipped.has(poolAddress)) continue;

      const cooldownUntil = failureCooldownUntil.get(poolAddress) || 0;
      if (now < cooldownUntil) continue;

      if (!firstSeenAt.has(poolAddress)) firstSeenAt.set(poolAddress, now);
      const ageHours = (now - firstSeenAt.get(poolAddress)) / 3_600_000;
      if (ageHours >= config.entry.expiryHours) {
        log.warn(
          `Pool ${poolAddress.slice(0, 8)} expired after ${config.entry.expiryHours}h without entry — dinonaktifkan`
        );
        tg.notifyPoolExpired({
          pool: poolAddress,
          pair: pairNameCache.get(poolAddress) || null,
          expiryHours: config.entry.expiryHours,
        });
        deactivatePool(poolAddress, "expired tanpa entry");
        continue;
      }

      if (getEntryUsage(poolAddress) >= maxPositions) {
        log.info(`Pool ${poolAddress.slice(0, 8)} reached max position (${maxPositions}) — skip`);
        skipped.add(poolAddress);
        continue;
      }

      if ((openBotByPool.get(poolAddress) || 0) >= config.entry.maxConcurrentBidaskDouble) {
        stillOpen.add(poolAddress);
        continue;
      }

      let info;
      try {
        info = await getPoolInfo(poolAddress);
      } catch (err) {
        log.warn(`Pool ${poolAddress.slice(0, 8)} lookup failed: ${err.message}`);
        continue;
      }
      if (info.unsupported) {
        const quoteLabel = info.quoteMint || `${info.xMint?.slice(0, 4) || "?"}/${info.yMint?.slice(0, 4) || "?"}`;
        log.warn(
          `Pool ${poolAddress.slice(0, 8)} rejected: pair bukan SOL (${info.pairName || poolAddress} | quote ${quoteLabel})`
        );
        tg.notifyPoolUnsupported({ pool: poolAddress, pair: info.pairName, quoteMint: quoteLabel });
        deactivatePool(poolAddress, "pair bukan SOL");
        continue;
      }
      if (!info.baseMint) {
        log.warn(`Pool ${poolAddress.slice(0, 8)} has no base mint — skip`);
        continue;
      }

      candidates.push({
        pool: poolAddress,
        mint: info.baseMint,
        sizeSol,
        pairName: info.pairName,
      });
    }

    // Sinkronkan enteredPools dengan posisi terbuka. Pertahankan entry yang
    // selesai setelah refresh ini mulai (belum sempat terlihat di openByPool).
    for (const pool of stillOpen) {
      if (!enteredPools.has(pool)) enteredPools.set(pool, 0);
    }
    for (const [pool, at] of enteredPools) {
      if (stillOpen.has(pool)) continue;
      if (at >= refreshStartedAt) continue;
      enteredPools.delete(pool);
    }

    candidateCache = candidates;
    return candidates;
  } catch (err) {
    log.error(`refreshCandidates failed: ${err.message}`);
    return null;
  } finally {
    _refreshBusy = false;
  }
}

// Poll harga cepat: hanya baca kandidat + state Supertrend, lalu satu request
// batch Jupiter. Tidak ada RPC di jalur ini.
export async function watchAndEnter() {
  if (!config.entry.enabled) return null;
  if (_watchBusy) return null;
  if (candidateCache.length === 0) return null;
  _watchBusy = true;

  try {
    const watchable = selectWatchCandidates(candidateCache, {
      inFlight: inFlightPools,
      entered: enteredPools,
      cooldowns: failureCooldownUntil,
      now: Date.now(),
    });
    if (watchable.length === 0) return null;

    const byPool = new Map(watchable.map((c) => [c.pool, c]));
    const { triggered } = await watchPrices(watchable.map((c) => ({ pool: c.pool, mint: c.mint })));

    for (const t of triggered) {
      const c = byPool.get(t.pool);
      if (c) startEntry(t, c);
    }

    return triggered.length > 0 ? triggered : null;
  } catch (err) {
    log.error(`watchAndEnter failed: ${err.message}`);
    return null;
  } finally {
    _watchBusy = false;
  }
}

// Jalankan entry tanpa memblokir poll harga berikutnya. Guard in-flight/entered
// mencegah retrigger selama swap/tx (10-30s) saat harga masih <= garis.
function startEntry(trigger, candidate) {
  const { pool, mint, sizeSol, pairName } = candidate;
  if (inFlightPools.has(pool) || enteredPools.has(pool)) return;

  const pair = pairName || `${mint.slice(0, 4)}-SOL`;
  log.info(
    `Pool ${pool.slice(0, 8)} touch: bullish line ${trigger.line} | harga ${trigger.price} — entry (first_touch)`
  );

  if (config.dryRun) {
    if (!dryRunNoted.has(pool)) {
      dryRunNoted.add(pool);
      log.info(`[DRY RUN] Would enter ${pair} — ${sizeSol} SOL split ${config.entry.sizeSplit}`);
    }
    return;
  }

  inFlightPools.add(pool);
  addEntryInProgressMint(mint);

  executeEntry(
    pool,
    {
      direction: trigger.direction,
      line: trigger.line,
      price: trigger.price,
      solPrice: trigger.solPrice,
      touchType: "price",
    },
    sizeSol
  )
    .then((result) => {
      if (result.success) {
        enteredPools.set(pool, Date.now());
        firstSeenAt.delete(pool);
        failureCooldownUntil.delete(pool);
        failureCounts.delete(pool);
        return;
      }

      // Rem harga kehabisan percobaan (harga pool meleset terus): batalkan dan
      // nonaktifkan pool (beri '#' di pool.txt) — bukan dihitung gagal biasa.
      if (result.skipped && result.exhausted) {
        log.warn(
          `Pool ${pool.slice(0, 8)} dibatalkan: ${result.reason || "harga pool menyimpang"} — dinonaktifkan`
        );
        deactivatePool(pool, "harga pool meleset terus");
        tg.notifyEntryAborted({
          pool,
          pair: pairName,
          attempts: result.attempts || config.entry.poolPriceMaxAttempts,
          error: result.reason || "harga pool menyimpang",
        });
        return;
      }
      if (result.skipped) {
        log.warn(`Pool ${pool.slice(0, 8)} dilewati: ${result.reason || "harga pool menyimpang"}`);
        return;
      }

      log.warn(`Entry failed for ${pool.slice(0, 8)}: ${result.error}`);
      const rateLimited = !!result.rateLimited;
      const failures = (failureCounts.get(pool) || 0) + 1;
      failureCounts.set(pool, failures);
      if (failures >= config.entry.maxFailures) {
        deactivatePool(pool, `gagal entry ${failures}x`);
        log.error(`Pool ${pool.slice(0, 8)} aborted after ${failures} failed entries — dinonaktifkan`);
        if (rateLimited) {
          tg.notifyEntryRateLimited({
            pool,
            pair: pairName,
            error: result.error,
            attempts: failures,
            maxFailures: config.entry.maxFailures,
            cooldownSec: 0,
          });
        } else {
          tg.notifyEntryAborted({
            pool,
            pair: pairName,
            attempts: failures,
            error: result.error,
          });
        }
      } else {
        const cooldownSec = Math.max(0, Number(config.entry.failureCooldownSec) || 0);
        const cooldownMs = cooldownSec * 1000;
        if (cooldownMs > 0) {
          failureCooldownUntil.set(pool, Date.now() + cooldownMs);
          log.info(
            `Pool ${pool.slice(0, 8)} cooldown ${config.entry.failureCooldownSec}s after failed entry (${failures}/${config.entry.maxFailures})`
          );
        }
        if (rateLimited) {
          tg.notifyEntryRateLimited({
            pool,
            pair: pairName,
            error: result.error,
            attempts: failures,
            maxFailures: config.entry.maxFailures,
            cooldownSec,
          });
        } else {
          tg.notifyEntryFailed({
            pool,
            pair: pairName,
            error: result.error,
            attempts: failures,
            maxFailures: config.entry.maxFailures,
            cooldownSec,
          });
        }
      }
    })
    .catch((err) => log.error(`Entry error for ${pool.slice(0, 8)}: ${err.message}`))
    .finally(() => {
      inFlightPools.delete(pool);
      removeEntryInProgressMint(mint);
    });
}

export function startEntryScanner() {
  const fastSec = Math.max(0.1, Number(config.jupiterPollIntervalSec) || 1);
  const slowSec = Math.max(5, Number(config.entry.scanIntervalSec) || 30);

  log.info(
    `Entry monitor started — kandidat refresh ${slowSec}s | Jupiter poll ${fastSec}s (signal: GMGN ${config.entry.timeframe} Supertrend bullish + Jupiter price <= line)`
  );

  refreshCandidates().catch((e) => log.error(`initial candidate refresh failed: ${e.message}`));
  const slowTimer = setInterval(
    () => refreshCandidates().catch((e) => log.error(`candidate refresh failed: ${e.message}`)),
    slowSec * 1000
  );
  const fastTimer = setInterval(
    () => watchAndEnter().catch((e) => log.error(`price watch failed: ${e.message}`)),
    fastSec * 1000
  );

  return { slowTimer, fastTimer };
}
