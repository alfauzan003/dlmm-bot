import config, { BINS_BELOW, BINS_ABOVE, STRATEGY } from "./config/index.js";
import log from "./core/logger.js";
import * as tg from "./notify/telegram.js";
import { startEntryScanner, getPoolNames } from "./entry/index.js";
import { startDcaWatcher } from "./entry/dca.js";
import { mainLoop } from "./exit/index.js";

const STRATEGY_LABEL = { spot: "Spot", curve: "Curve", bid_ask: "BidAsk" };

log.info("========================================");
log.info("  Meteora Bot starting...");
log.info(`  Mode: ${config.dryRun ? "DRY RUN" : "LIVE"} (dari .env) | SOL_MODE: ${config.solMode} (strat.conf/.env)`);
log.info(
  `  Entry: per-pool size from ${config.entry.poolListFile} | split ${config.entry.sizeSplit} | bins -34/+34 BidAsk | kandidat ${config.entry.scanIntervalSec}s | Jupiter poll ${config.jupiterPollIntervalSec}s`
);
log.info("========================================");

if (!config.walletPrivateKey) {
  log.error("WALLET_PRIVATE_KEY is not set — exiting");
  process.exit(1);
}

const poolNames = await getPoolNames();

tg.notifyStartup({
  mode: config.dryRun ? "DRY RUN" : "LIVE",
  strategy: STRATEGY_LABEL[STRATEGY] || STRATEGY,
  binsBelow: BINS_BELOW,
  binsAbove: BINS_ABOVE,
  sizeSplit: config.entry.sizeSplit,
  scanIntervalSec: config.entry.scanIntervalSec,
  jupiterPollIntervalSec: config.jupiterPollIntervalSec,
  timeframe: config.entry.timeframe,
  expiryHours: config.entry.expiryHours,
  poolNames,
});

// Entry scanner (Supertrend touch) — own cadence
startEntryScanner();

// DCA watcher (arm/trail/confirm) — own cadence (DCA_POLL_INTERVAL_SEC)
startDcaWatcher();

// Exit monitor (deterministic rules from exitbot) — runs forever
mainLoop().catch((err) => {
  log.error(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
