import log from "../core/logger.js";
import { getTokenBalance } from "../solana/balances.js";
import { swapToSol } from "../solana/swap.js";
import { claimPositionFees } from "../meteora/claim.js";
import { addKeepMint, removeKeepMint } from "../state/keep-mints.js";
import { getTrackedPosition } from "../state/positions.js";
import { getTrade, tryLockTrade, unlockTrade } from "../state/trades.js";

// Swap seluruh saldo base token ke SOL satu kali. Mengembalikan swapInfo
// (bentuk sama dengan handleClose) atau null bila tidak ada token.
export async function swapBaseToSol(baseMint, deps = {}) {
  if (!baseMint) return null;
  const balanceOf = deps.getTokenBalance ?? getTokenBalance;
  const swap = deps.swapToSol ?? swapToSol;
  const balance = await balanceOf(baseMint);
  if (!(balance > 0)) return null;
  const res = await swap(baseMint, balance);
  const ok = res?.success === true;
  if (!ok) log.warn(`Swap failed for ${baseMint.slice(0, 8)}: ${res?.error}`);
  return {
    mint: baseMint.slice(0, 8),
    success: ok,
    error: ok ? null : String(res?.error || "unknown").split("\n")[0],
  };
}

// Klaim fee semua leg yang masih terbuka; opsional swap saldo base token sekali.
export async function claimTrade(trade, { swap = false, deps = {} } = {}) {
  const claim = deps.claimPositionFees ?? claimPositionFees;
  const empty = { claimed: 0, failed: [], swapInfo: null };

  if (!tryLockTrade(trade.id, "claim")) return { success: false, busy: true, ...empty };

  try {
    const t = getTrade(trade.id) ?? trade;
    if (t.closed === true) return { success: false, ...empty, error: "trade already closed" };

    let claimed = 0;
    const failed = [];
    for (const addr of t.positions) {
      if (getTrackedPosition(addr)?.closed === true) continue;
      try {
        const res = await claim(addr);
        if (res?.success) claimed++;
        else {
          failed.push(addr);
          log.warn(`Claim failed for ${addr.slice(0, 8)}: ${res?.error}`);
        }
      } catch (err) {
        failed.push(addr);
        log.warn(`Claim error for ${addr.slice(0, 8)}: ${err.message}`);
      }
    }

    // Fee yang sudah masuk wallet tetap di-swap walau ada leg yang gagal diklaim.
    const swapInfo = swap && claimed > 0 ? await swapBaseToSol(t.baseMint, deps) : null;
    // Claim tanpa swap: fee token sengaja disimpan pengguna -> jangan dijual safety sweep.
    if (claimed > 0) (swap ? removeKeepMint : addKeepMint)(t.baseMint);
    return { success: failed.length === 0 && swapInfo?.success !== false, claimed, failed, swapInfo };
  } finally {
    unlockTrade(trade.id);
  }
}
