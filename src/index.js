import config from "./config/index.js";
import log from "./core/logger.js";
import { startBot } from "./tg/bot.js";
import * as start from "./tg/start.js";
import * as help from "./tg/help.js";
import * as settings from "./tg/settings.js";
import { startEntryScanner } from "./entry/index.js";
import { startDcaWatcher } from "./entry/dca.js";
import { mainLoop } from "./exit/index.js";

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

// Bot Telegram + kartu home: tidak di-await agar Telegram yang lambat tidak menunda scanner / exit loop.
startBot([start, help, settings])
  .then((bot) => bot && start.sendHome(bot.api, { prefix: "🟢 Online" }))
  .catch((err) => log.error(`Telegram startup gagal: ${err?.message ?? err}`));

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
