import config from "./config/index.js";
import log from "./core/logger.js";
import { startBot } from "./tg/bot.js";
import { hasWalletKey } from "./solana/wallet.js";
import * as start from "./tg/start.js";
import * as help from "./tg/help.js";
import * as settings from "./tg/settings.js";
import * as positions from "./tg/positions.js";
import * as openWizard from "./tg/open-wizard.js";
import * as pnl from "./tg/pnl.js";
import * as wallet from "./tg/wallet.js";
import { startEntryScanner } from "./entry/index.js";
import { mainLoop } from "./exit/index.js";
import { legacyAdoptionCount, tradeExitLoop } from "./exit/trade-loop.js";

log.info("========================================");
log.info("  Meteora Bot starting...");
log.info(`  Mode: ${config.dryRun ? "DRY RUN" : "LIVE"} (dari .env) | SOL_MODE: ${config.solMode} (strat.conf/.env)`);
log.info(
  `  Entry: per-pool size from ${config.entry.poolListFile} | split ${config.entry.sizeSplit} | bins -34/+34 BidAsk | kandidat ${config.entry.scanIntervalSec}s | Jupiter poll ${config.jupiterPollIntervalSec}s`
);
log.info("========================================");

if (!hasWalletKey()) {
  log.error("Wallet key is not set (wallet.key or WALLET_PRIVATE_KEY) — exiting");
  process.exit(1);
}

// Dihitung sebelum loop exit sempat mengadopsi: posisi bot lama yang diadopsi tanpa TP/SL.
const legacyCount = legacyAdoptionCount();
if (legacyCount > 0) log.warn(`${legacyCount} posisi lama akan diadopsi tanpa TP/SL — atur di /positions`);

// Bot Telegram + kartu home: tidak di-await agar Telegram yang lambat tidak menunda scanner / exit loop.
startBot([start, help, settings, positions, openWizard, pnl, wallet])
  .then((bot) => bot && start.sendHome(bot.api, { prefix: start.onlinePrefix(legacyCount) }))
  .catch((err) => log.error(`Telegram startup gagal: ${err?.message ?? err}`));

// Entry scanner (Supertrend touch) — own cadence
startEntryScanner();

// TP/SL/Trail per trade — own cadence (TRADE_EXIT_INTERVAL_SEC)
tradeExitLoop(config.tradeExitIntervalSec).catch((err) => {
  log.error(`Fatal trade exit error: ${err.message}`);
  console.error(err);
  process.exit(1);
});

// Exit monitor (deterministic rules from exitbot) — runs forever
mainLoop().catch((err) => {
  log.error(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
