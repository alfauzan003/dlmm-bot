import config from "../config/index.js";
import { getEntryInProgressMints } from "../entry/runtime.js";
import { sweepToSol } from "../solana/swap.js";

const sweepFailedUntil = new Map();

// Safety sweep: once per cycle, swap every token balance to SOL except the
// configured exclusions (default USDC), WSOL, and tokens being acquired by an
// in-flight entry. Mints that fail to swap get a per-mint backoff.
export async function runSafetySweep() {
  const now = Date.now();
  const exclude = new Set(config.swap.excludeMints || []);
  for (const mint of getEntryInProgressMints()) exclude.add(mint);
  for (const [mint, until] of sweepFailedUntil) {
    if (now < until) exclude.add(mint);
    else sweepFailedUntil.delete(mint);
  }

  const result = await sweepToSol({ excludeMints: [...exclude] });

  const cooldownMs = Math.max(0, Number(config.swap.failureCooldownSec) || 0) * 1000;
  if (cooldownMs > 0) {
    for (const mint of result?.failedMints || []) {
      sweepFailedUntil.set(mint, Date.now() + cooldownMs);
    }
  }
}
