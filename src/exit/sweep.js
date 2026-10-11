import config from "../config/index.js";
import { getEntryInProgressMints } from "../entry/runtime.js";
import { sweepToSol } from "../solana/swap.js";
import { isOn } from "../state/settings.js";
import { listKeepMints } from "../state/keep-mints.js";

const sweepFailedUntil = new Map();
// Sweep hanya untuk otomasi lama; tanpa itu, token di wallet milik pengguna.
const LEGACY_TOGGLES = ["autoEntry", "deterministicExit", "dca"];

// Safety sweep: once per cycle, swap every token balance to SOL except the
// configured exclusions (default USDC), WSOL, tokens being acquired by an
// in-flight entry, and mints the user kept (Close only / plain Claim).
// Runs only while a legacy automation toggle is ON. Mints that fail to swap
// get a per-mint backoff.
export async function runSafetySweep({ deps = {} } = {}) {
  if (!LEGACY_TOGGLES.some((name) => isOn(name))) return;
  const sweep = deps.sweepToSol ?? sweepToSol;
  const now = Date.now();
  const exclude = new Set(config.swap.excludeMints || []);
  for (const mint of getEntryInProgressMints()) exclude.add(mint);
  for (const mint of listKeepMints()) exclude.add(mint);
  for (const [mint, until] of sweepFailedUntil) {
    if (now < until) exclude.add(mint);
    else sweepFailedUntil.delete(mint);
  }

  const result = await sweep({ excludeMints: [...exclude] });

  const cooldownMs = Math.max(0, Number(config.swap.failureCooldownSec) || 0) * 1000;
  if (cooldownMs > 0) {
    for (const mint of result?.failedMints || []) {
      sweepFailedUntil.set(mint, Date.now() + cooldownMs);
    }
  }
}
