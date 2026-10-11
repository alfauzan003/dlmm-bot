import config from "../config/index.js";
import log from "../core/logger.js";
import { sleep } from "../core/utils.js";
import * as tg from "../notify/telegram.js";
import { getTokenBalance } from "../solana/balances.js";
import { openTokenOnlyPosition } from "../meteora/open-token-position.js";
import { addEntryInProgressMint, removeEntryInProgressMint } from "../entry/runtime.js";
import { handleClose } from "./close.js";

// Guard per-posisi: cegah fallback jalan dobel untuk posisi yang sama.
const fallbackInProgress = new Set();

// OOR kiri spot: tutup posisi tanpa swap, lalu pakai seluruh saldo token untuk
// membuka posisi `bidask:token` satu-sisi di pool yang sama.
// Return true bila alur fallback ditangani (termasuk kegagalan); false bila
// fallback nonaktif sehingga pemanggil harus close biasa.
export async function handleSpotOorKiri(pos) {
  const cfg = config.spotFallback;
  if (!cfg?.enabled || !pos?.baseMint) return false;

  const baseMint = pos.baseMint;
  const pool = pos.pool;
  const pair = pos.pair || pos.position?.slice(0, 8) || "?";
  const positionAddress = pos.position;

  if (positionAddress && fallbackInProgress.has(positionAddress)) {
    log.info(`Fallback ${pair}: sudah diproses, lewati`);
    return true;
  }
  if (positionAddress) fallbackInProgress.add(positionAddress);

  // Lindungi token dari safety sweep selama proses (token ada di wallet sampai
  // posisi token-only berhasil dibuka).
  addEntryInProgressMint(baseMint);

  try {
    // Tutup tanpa swap & tanpa menonaktifkan pool.
    const closeRes = await handleClose(pos, "oor_kiri", { skipAutoSwap: true, skipDeactivate: true });
    if (!closeRes?.success) {
      log.warn(`Fallback ${pair}: close gagal — token tidak diproses`);
      return true;
    }

    const balance = await getTokenBalance(baseMint);
    if (!Number.isFinite(balance) || balance <= 0) {
      log.info(`Fallback ${pair}: saldo token kosong — fallback dilewati`);
      return true;
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= cfg.retry; attempt++) {
      const res = await openTokenOnlyPosition({
        poolAddress: pool,
        baseMint,
        tokenAmountUi: balance,
        binsAbove: cfg.binsAbove,
        binsBelow: cfg.binsBelow,
        distribution: cfg.distribution,
        pairName: pos.pair,
      });
      if (res.success) {
        log.info(`Fallback ${pair}: posisi token-only dibuka (${balance} token)`);
        tg.notifyFallback({ pair, pool, success: true, amount: balance });
        return true;
      }
      lastErr = res.error || "unknown";
      log.warn(`Fallback ${pair}: buka token-only gagal ${attempt}/${cfg.retry}: ${lastErr}`);
      if (attempt < cfg.retry) await sleep(3000);
    }

    log.error(`Fallback ${pair}: gagal buka token-only setelah ${cfg.retry}x — token dilepas (bisa di-sweep)`);
    tg.notifyFallback({ pair, pool, success: false, error: lastErr });
    return true;
  } catch (err) {
    log.error(`Fallback ${pair} error: ${err.message}`);
    tg.notifyFallback({ pair, pool, success: false, error: err.message });
    return true;
  } finally {
    removeEntryInProgressMint(baseMint);
    if (positionAddress) fallbackInProgress.delete(positionAddress);
  }
}
