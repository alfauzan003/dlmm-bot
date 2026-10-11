import config from "../config/index.js";
import { isOn } from "../state/settings.js";
import { LEGACY_MODE } from "../config/rules.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { getTrackedPosition, getOpenTrackedPositions } from "../state/positions.js";
import { findTradeByPosition } from "../state/trades.js";
import { fetchPoolPnl, pnlFromEntry } from "../meteora/positions.js";
import { loadPoolList } from "./pool-list.js";
import { executeEntry } from "./execute.js";
import {
  isDcaEligible,
  evaluateDca,
  setDcaArmedAndTrough,
  queueDcaRebound,
  resolvePendingDca,
  clearPendingDca,
  markDcaTriggered,
  clearDcaTriggered,
  getPoolDcaCount,
  incrementPoolDca,
  decrementPoolDca,
  effectiveDcaArmPct,
} from "../state/dca.js";
import {
  isEntryInProgressPool,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  isPoolClosing,
  getDcaCooldownUntil,
  setDcaCooldown,
  recordAction,
} from "./runtime.js";

// DCA hanya untuk mode yang terdaftar di config.dca.eligibleModes (default
// bidask:double). Label mode lama dinormalkan lewat LEGACY_MODE.
export function isDcaModeEligible(mode) {
  const normalized = LEGACY_MODE[mode] || mode;
  return (config.dca.eligibleModes || []).includes(normalized);
}

// DCA hanya untuk posisi hasil auto-entry: mode eligible DAN trade terbuka
// milik posisi itu ber-origin "auto". Manual / external / belum ada trade -> tidak.
export function isDcaPositionEligible(tracked) {
  if (!tracked?.position || !isDcaModeEligible(tracked.mode)) return false;
  return findTradeByPosition(tracked.position)?.origin === "auto";
}

// Dipanggil tiap tick watcher DCA. Satu request PnL per pool dipakai untuk
// scan (arm/trail/queue) sekaligus konfirmasi rebound — tidak ada timer
// terpisah. Posisi diambil dari state (tanpa RPC).
export async function tickDca() {
  const cfg = config.dca;
  if (!isOn("dca")) return;

  const open = getOpenTrackedPositions().filter((t) => t && t.position && t.pool && isDcaPositionEligible(t));
  if (open.length === 0) return;

  const byPool = new Map();
  for (const t of open) {
    if (!byPool.has(t.pool)) byPool.set(t.pool, []);
    byPool.get(t.pool).push(t);
  }

  for (const [pool, list] of byPool) {
    const pnlMap = await fetchPoolPnl(pool, { force: true, ttlSec: cfg.pollIntervalSec });
    const now = Date.now();
    // Ambang arm efektif: DCA#2 pakai armPct2 (posisi utama) hanya jika DCA#1
    // sudah close; selama DCA#1 masih open, pakai armPct dari posisi DCA#1.
    const count = getPoolDcaCount(pool);
    const dcaOpen = list.some((t) => t.isDca === true);
    const poolCfg = { ...cfg, armPct: effectiveDcaArmPct(count, dcaOpen, cfg) };

    for (const tracked of list) {
      const entry = pnlMap.get(tracked.position);
      const pnlPct = entry ? pnlFromEntry(entry) : null;
      const pairLabel = tracked.pair || tracked.position.slice(0, 8);

      // Posisi tidak ada di respons PnL -> batalkan pending; loop exit yang
      // akan menandai posisi closed bila memang hilang.
      if (entry == null || pnlPct == null) {
        if (tracked.pendingDcaTrough != null) clearPendingDca(tracked.position);
        continue;
      }

      const pos = { position: tracked.position, pool, pair: tracked.pair, pnlPct };

      // Konfirmasi rebound pending setelah lewat confirmDelaySec.
      if (tracked.pendingDcaTrough != null) {
        const waitedSec = (now - (tracked.pendingDcaStartedAt || 0)) / 1000;
        if (waitedSec >= cfg.confirmDelaySec) {
          const resolved = resolvePendingDca(tracked.position, pnlPct, cfg.reboundPct);
          if (resolved.confirmed) {
            const fresh = getTrackedPosition(tracked.position);
            maybeStartDca(pos, fresh, pairLabel);
          } else if (resolved.rejected) {
            log.debug(`[detail] ${pairLabel}: DCA rebound ditolak (PnL balik ke trough)`);
          }
        }
        continue;
      }

      processDca(pos, tracked, pairLabel, poolCfg);
    }
  }
}

// Watcher DCA: cadence sendiri (DCA_POLL_INTERVAL_SEC), terpisah dari loop
// exit 12s. Tidak menyentuh RPC/pnl-history, hanya PnL datapi yang di-cache
// dan dipakai bersama exit loop.
export function startDcaWatcher() {
  const cfg = config.dca;
  const sec = Math.max(1, Number(cfg.pollIntervalSec) || 5);

  log.info(
    `DCA watcher started — PnL poll ${sec}s | arm ${cfg.armPct}%/${cfg.armPct2}% | rebound ${cfg.reboundPct}pt | konfirmasi ${cfg.confirmDelaySec}s | max ${cfg.maxAdds}/sesi`
  );

  tickDca().catch((e) => log.error(`DCA watcher error: ${e.message}`));
  const timer = setInterval(() => {
    tickDca().catch((e) => log.error(`DCA watcher error: ${e.message}`));
  }, sec * 1000);

  return { timer };
}

// Arm / trail / queue rebound dari PnL hasil fetch.
export function processDca(pos, tracked, pairLabel, cfgOverride) {
  const cfg = cfgOverride || config.dca;
  if (!isOn("dca") || !pos?.position || pos.pnlPct == null) return;

  tracked = getTrackedPosition(pos.position);
  if (!isDcaEligible(tracked)) return;
  if (!isDcaPositionEligible(tracked)) return;
  // Konfirmasi sedang berjalan — diselesaikan tick berikutnya.
  if (tracked.pendingDcaTrough != null) return;

  const decision = evaluateDca(pos, tracked, { ...cfg, enabled: true });
  switch (decision.action) {
    case "arm":
      setDcaArmedAndTrough(pos.position, decision.trough);
      log.debug(`[detail] ${pairLabel}: DCA armed @ ${decision.trough.toFixed(2)}% (trough awal)`);
      break;
    case "trail":
      setDcaArmedAndTrough(pos.position, decision.trough);
      break;
    case "queue_rebound":
      queueDcaRebound(pos.position, decision.trough, decision.current);
      log.debug(
        `[detail] ${pairLabel}: DCA rebound ${decision.rebound.toFixed(2)}% dari trough ${decision.trough.toFixed(2)}% → konfirmasi ${cfg.confirmDelaySec}s`
      );
      break;
    default:
      break;
  }
}

// Eksekusi DCA. Guard + reservasi sinkron, eksekusi async (fire-and-forget).
export function maybeStartDca(pos, tracked, pairLabel) {
  const cfg = config.dca;
  if (!isOn("dca") || !pos?.position || !pos?.pool || pos.pnlPct == null) return false;
  if (!isDcaEligible(tracked)) return false;
  if (!isDcaPositionEligible(tracked)) return false;
  if (isEntryInProgressPool(pos.pool)) return false;
  if (isPoolClosing(pos.pool)) return false;
  if (Date.now() < getDcaCooldownUntil(pos.pool)) return false;
  if (getPoolDcaCount(pos.pool) >= cfg.maxAdds) {
    log.debug(`[detail] Pool ${pos.pool.slice(0, 8)} DCA quota sesi tercapai (${cfg.maxAdds}) — skip`);
    return false;
  }

  const entry = loadPoolList().find((x) => x.pool === pos.pool);
  if (!entry || !(entry.sizeSol > 0)) {
    log.warn(`Pool ${pos.pool.slice(0, 8)} DCA skip: entry_size tidak ditemukan di pool.txt`);
    return false;
  }

  const pair = pos.pair || pairLabel || pos.pool.slice(0, 8);

  // Reservasi sinkron: cegah posisi lain di pool sama memicu DCA bersamaan.
  // Counter sesi dinaikkan sebelum eksekusi agar tahan crash/restart.
  markDcaTriggered(pos.position);
  incrementPoolDca(pos.pool);
  addEntryInProgressPool(pos.pool);

  log.debug(
    `[detail] Pool ${pos.pool.slice(0, 8)} DCA: PnL ${pos.pnlPct.toFixed(2)}% → entry baru ${entry.sizeSol} SOL (${pair})`
  );

  if (config.dryRun) {
    log.info(`[DRY RUN] Akan DCA ${pair} — ${entry.sizeSol} SOL`);
    removeEntryInProgressPool(pos.pool);
    return true;
  }

  executeEntry(pos.pool, { direction: "bullish", line: null, price: null, touchType: "dca" }, entry.sizeSol, {
    countUsage: false,
    isDca: true,
  })
    .then((result) => {
      if (result.success) {
        log.info(`📉 DCA ${pair} — posisi turun lalu memantul → tambah ${entry.sizeSol} SOL`);
        log.debug(`[detail] DCA position ${result.position} | tx ${result.tx?.slice(0, 16) || "-"}`);
        recordAction(`DCA ${pair} — tambah ${entry.sizeSol} SOL`);
        tg.notifyDca({ pair, pool: pos.pool, pnlPct: pos.pnlPct, sizeSol: entry.sizeSol });
        return;
      }
      // Rem harga kehabisan percobaan: hentikan DCA untuk posisi ini saja
      // (biarkan dcaTriggered=true), kembalikan kuota sesi. Pool TIDAK
      // dinonaktifkan; exit posisi terbuka tetap jalan lewat state.
      if (result.skipped && result.exhausted) {
        decrementPoolDca(pos.pool);
        log.warn(`DCA ${pair} dihentikan: ${result.reason || "harga pool menyimpang"} — DCA posisi ini tidak dilanjut`);
        tg.notifyError(`DCA ${pair} dihentikan: ${result.reason || "harga pool menyimpang"}`);
        return;
      }
      if (result.skipped) {
        clearDcaTriggered(pos.position);
        decrementPoolDca(pos.pool);
        log.warn(`DCA ${pair} dilewati: ${result.reason || "harga pool menyimpang"}`);
        return;
      }
      log.warn(`DCA failed for ${pos.pool.slice(0, 8)}: ${result.error}`);
      clearDcaTriggered(pos.position);
      decrementPoolDca(pos.pool);
      setDcaCooldown(pos.pool, cfg.cooldownSec * 1000);
      tg.notifyError(`DCA failed ${pair}: ${result.error}`);
    })
    .catch((err) => {
      log.error(`DCA error for ${pos.pool.slice(0, 8)}: ${err.message}`);
      clearDcaTriggered(pos.position);
      decrementPoolDca(pos.pool);
      setDcaCooldown(pos.pool, cfg.cooldownSec * 1000);
    })
    .finally(() => removeEntryInProgressPool(pos.pool));

  return true;
}
