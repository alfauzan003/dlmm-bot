# Meteora LP Assistant

A single-user Telegram assistant for providing liquidity on [Meteora DLMM](https://www.meteora.ag) pools on Solana.
You drive it from a chat with your own bot: open liquidity with SOL, claim fees, set take-profit / stop-loss /
trailing, close, and track profit in USD. It runs as one Node.js process on your own server and uses one wallet.

The older auto-entry (open on a Supertrend signal) is still in the code. It is off by default and can be switched
on and off from Telegram. Exits are always per trade (TP / SL / Trail).

**This bot sends real Solana transactions.** Always start with `DRY_RUN=true`.

## Requirements

- Node.js 24.x (the `postinstall` step patches dependencies to run on Node 24)
- A Solana wallet funded with SOL, and an RPC endpoint (Helius works well)
- A Telegram bot token from [@BotFather](https://t.me/BotFather) and your own numeric chat id

## Setup

1. Install dependencies. This also runs the Node 24 patch script, so do not use `--ignore-scripts`.

   ```bash
   npm install
   ```

2. Create your config and fill it in.

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

   | Variable                    | What it is                                                                               |
   | --------------------------- | ---------------------------------------------------------------------------------------- |
   | `WALLET_PRIVATE_KEY`        | Wallet secret key (base58 or JSON array). A `wallet.key` file, if present, overrides it. |
   | `RPC_URL`, `HELIUS_API_KEY` | Solana RPC and Helius access                                                             |
   | `JUPITER_API_KEY`           | Jupiter key (or the separate `JUPITER_PRICE_API_KEY` / `JUPITER_SWAP_API_KEY`)           |
   | `GMGN_API_KEY`              | Only needed for auto-entry candles                                                       |
   | `TELEGRAM_BOT_TOKEN`        | Token from BotFather                                                                     |
   | `TELEGRAM_CHAT_ID`          | Your chat id. Message [@userinfobot](https://t.me/userinfobot) to find it.               |
   | `DRY_RUN`                   | `true` = no transactions or swaps are sent. Anything other than `false` counts as on.    |

3. Start in dry-run mode (`DRY_RUN=true`), then send `/start` to your bot. Walk through `/open` and check the
   confirm screen. When you are happy, set `DRY_RUN=false` and restart, and try a small deposit first.

   ```bash
   npm start
   ```

Strategy defaults live in `strat.conf` (committed to git). If a key is in both files, `strat.conf` wins over `.env`.
`SOL_MODE=false` there, so all profit and loss is in USD.

## Commands

| Command      | What it does                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `/start`     | Main menu and wallet card: address, balance, open trades, open PnL, active toggles, DRY RUN badge |
| `/open`      | Open liquidity from a token mint or pool address                                                  |
| `/positions` | List open trades; claim fees, set TP / SL / Trail, close                                          |
| `/pnl`       | Profit Today / This week / This month, recent closes, Metlex hand-off                             |
| `/wallet`    | Deposit address, withdraw, export key, import key                                                 |
| `/settings`  | Four on/off toggles, the Auto Exit defaults, range presets and deposit quick-picks                |
| `/help`      | Short how-to and command list                                                                     |

You can also paste a token mint or pool address anywhere in the chat to start `/open`. The bot sends a short
"Online" message with the main menu each time it starts.

## Opening a position

1. Send a pool address or a token mint. For a mint, the bot lists the top SOL pools by TVL; pick one. Only SOL pairs
   are supported.
2. **Deposit** (SOL): `0.5`, `0.7`, `0.9`, `1` or `Custom`. There is no default. The four quick-pick amounts can be
   changed in `/settings` → `💰 Deposits`.
3. **Range**: pick a preset or send a custom range.
4. **Shape**: pick how liquidity is spread.
5. Review the confirm screen (range as % and as prices, bins, number of positions, SOL to swap, refundable rent,
   Auto Exit settings) and tap Confirm.

Before opening, the bot checks that your balance covers the deposit, a 0.08 SOL buffer, and extra rent for wide
ranges. If not, it shows the shortfall and stops. One trade can use up to 10 on-chain positions; wider ranges are
refused.

### Range presets

| Preset         | Below / above price | Swap SOL to token? |
| -------------- | ------------------- | ------------------ |
| Narrow         | -20% / +20%         | yes                |
| Balanced       | -45% / +45%         | yes                |
| Wide           | -65% / +65%         | yes                |
| Narrow SOL     | -20% / 0            | no (SOL only)      |
| Balanced SOL   | -45% / 0            | no (SOL only)      |
| Wide SOL       | -65% / 0            | no (SOL only)      |
| Custom `45`    | -45% / 0            | no (SOL only)      |
| Custom `45 10` | -45% / +10%         | yes                |

Custom rules: below must be above 0 and at most 99; above must be 0 to 1000. Anything else is rejected.
The preset buttons show their range, e.g. `Narrow (−20%/+20%)`. Change a preset's values in `/settings` →
`📐 Range presets` (two numbers like `20 20`; the SOL presets take one number and stay SOL only), or reset them to
the defaults above.
When the range reaches above the current price, part of the deposit is swapped to the token through Jupiter.

### Shapes

| Shape     | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `spot`    | Even spread (default, marked with a check)                                  |
| `curve`   | Concentrated around the current price                                       |
| `bid_ask` | Heavier at the edges                                                        |
| `mixed`   | 70% of the deposit as bid_ask, 30% as spot, on the same range and positions |

## Managing trades

`/positions` shows one line per open trade. Tap a trade for its card (range, fees, PnL and peak, exit settings):

- **Claim** collects fees; **Claim+swap** also swaps the claimed token to SOL.
- **TP / SL / Trail** prompts: `15` or `off`, `25` or `off`, `5 3` or `off`.
- **Close** asks for `Close + swap to SOL` or `Close only`.

Trade PnL % is total PnL in USD divided by total USD deposited, with unclaimed fees included. If some positions of
a trade are already closed, TP / SL / Trail use the PnL of the positions still open.

**Tokens left in the wallet.** With Auto Entry OFF the bot never sells tokens on its own. While it is ON, a safety
sweep swaps stray tokens to SOL every cycle, except the excluded mints (USDC by
default), tokens being bought for an open, and tokens you kept with **Close only** or plain **Claim**. A kept token
is swept again only after you close or claim that token with swap.

### Auto Exit

New trades get these defaults while the Auto Exit toggle is ON (edit them in `/settings`, or per trade in
`/positions`). With it OFF, new trades start with all three exits off.

| Exit        | Default              | Closes when                                             |
| ----------- | -------------------- | ------------------------------------------------------- |
| Take profit | 15                   | PnL reaches +15%                                        |
| Stop loss   | 25                   | PnL falls to -25%                                       |
| Trailing    | start 5 / distance 3 | after PnL reaches +5%, it falls 3 points below its peak |

Before any automatic close the bot re-checks the PnL once and closes only if the trigger still holds.

### Exit strategy · Evil Panda

An optional per-trade exit that runs next to TP / SL / Trail (whichever fires first closes the trade). It reads the
token's 15m candles; the Supertrend break is always judged on closed bars:

1. While price is above the 15m Supertrend, the trade is kept.
2. When a closed bar breaks below the Supertrend (after the trade has seen price above it), Evil Panda **arms**.
3. While armed, the next spike closes the trade: RSI(2) closes above 90, the first green MACD histogram bar, or a
   close above the upper Bollinger Band — each signal can be switched on or off (default: RSI only).
4. If a bar closes back above the Supertrend first, it disarms and the trade keeps earning fees.

With `EVIL_PANDA_SIGNAL_MODE=live` (default) an armed trade also checks the spike on the live Jupiter price every
monitor check, treating it as the close of the forming bar — so it sells into the wick instead of waiting for the
bar to close (it can fire on a spike that would have faded by the close). `close` checks only closed bars. Either
way, a live price back above the Supertrend line never closes the trade.

A trade opened while price is already below the Supertrend waits for a real break before it can arm. Turn it on or
off per trade with **🐼 Panda** in `/positions` (the card shows `🐼 Evil Panda armed` while armed). New trades start
with it on when Auto Exit is ON and `EVIL_PANDA_DEFAULT_ON=true`. Tune it in **/settings → 🐼 Exit strategy → Evil
Panda**. The close alert shows which signal fired, e.g. `Evil Panda (RSI)`.

## Settings and toggles

| Toggle     | First-start value | Effect                                                      |
| ---------- | ----------------- | ----------------------------------------------------------- |
| Auto Exit  | ON                | Attach TP / SL / Trail defaults to new trades               |
| Auto Entry | OFF               | Scan `pool.txt` and open positions on the Supertrend signal |

The toggles are saved in `settings.json`. They take effect without a restart and are the only on/off switch for
these features.

**🧩 Strategy** (in `/settings`) shows every key of `strat.conf`, grouped by its `# ===== … =====` sections (General, Auto
Entry · Pools & sizing / Signal / Safety, Exit strategy · Evil Panda, Transactions, Swap & sweep, Monitoring, Market data & rate limits, Logs).
The comment block right under a section header is shown as that section's description, and the comment above each
key as its help. Changing a value there saves it as an override in `settings.json`
(`stratOverrides`); `strat.conf` stays the committed default and **↩ Reset to default** / **Reset all overrides**
go back to it. Overrides apply right away, except keys marked ⟳ (loop intervals, log level/retention, rate
limits), which apply after a restart. Precedence: `.env` < `strat.conf` < overrides. Secrets and `DRY_RUN` live
only in `.env` and are never shown.

## Upgrading from the old bot

- Positions the old bot already tracked (in `state.json`) are adopted as trades **without TP / SL / Trail**, so
  nothing is sold on the first start. The online message says how many; set exits per trade in `/positions`.
- Auto Entry starts OFF. Turn it on in `/settings` to keep the old entry behavior.
- The old rule-based "deterministic" exit (per-mode stop loss, OOR, indicators, trailing, low yield, OOR fallback
  and spot re-entry) has been removed, along with its `BIDASK_*` / `SPOT_*` / `TIMEFRAME` / `TRAILING_*` keys.
  Use TP / SL / Trail per trade instead. Leftover overrides for removed keys in `settings.json` are ignored.

## PnL and Metlex

`/pnl` shows realized USD profit for Today, This week (from Monday) and This month, with trade count, win rate,
best and worst trade, and unrealized PnL of open trades. Periods start at 00:00 WIB (UTC+7), and all times are WIB.
Only trades closed by this version are counted; old SOL-based history is not imported.

Close alerts and "Recent closes" show the close transaction as tap-to-copy text with an **Open Metlex** button
(`https://www.metlex.io/pnl-cards`). Metlex has no API, so paste the transaction there yourself to make a PnL card.

## Wallet

| Action   | How it works                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deposit  | Shows your address as tap-to-copy text                                                                                                                                         |
| Withdraw | Destination address, then amount or `max` (keeps 0.01 SOL for fees), then confirm                                                                                              |
| Export   | Warning, then "I understand"; the key is sent and the bot deletes that message after 60 seconds                                                                                |
| Import   | Refused while any trade is open or an open is in progress. Your message with the key is deleted at once, the key is saved to `wallet.key`, and the wallet switches immediately |

`wallet.key` overrides `WALLET_PRIVATE_KEY`. To go back to the `.env` wallet, delete `wallet.key` and restart.
A private key pasted anywhere else in the chat is deleted automatically.

## Security notes

- A key sent through Telegram passes through Telegram's servers even after you delete the message. Treat an exported
  key as exposed to that extent, and move funds if that worries you.
- Keep `.env` and `wallet.key` private (`chmod 600`) and never commit them. Both are git-ignored.
- The bot answers only `TELEGRAM_CHAT_ID`. Messages from any other chat are ignored and logged.
- Do not share your bot token.
- Wizards, prompts and confirm buttons expire after 10 minutes. A confirm button works once.

## Runtime files

These are created while the bot runs and are git-ignored. Do not edit them while the bot is running.

| File                                                             | Purpose                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `state.json`                                                     | Trades, positions and auto-entry/exit state                                              |
| `settings.json`                                                  | Toggles, Auto Exit defaults, range and deposit presets                                   |
| `wallet.key`                                                     | Imported wallet key (overrides `.env`)                                                   |
| `pool.txt`                                                       | Pools for auto-entry, one address per line; the bot comments out finished pools with `#` |
| `decision-log.json`, `pnl-history.json`, `supertrend-cache.json` | Logs and caches                                                                          |
| `logs/`                                                          | Process logs (PM2)                                                                       |

## Scripts

| Command                                               | Purpose                                |
| ----------------------------------------------------- | -------------------------------------- |
| `npm start` / `npm run dev`                           | Run the bot in the foreground          |
| `npm test`                                            | Run tests (`node --test`)              |
| `npm run lint` / `lint:fix`                           | ESLint                                 |
| `npm run format` / `format:check`                     | Prettier                               |
| `npm run pm2` / `pm2:stop` / `pm2:logs` / `pm2:monit` | Run and watch under PM2                |
| `npm run pm2:logrotate`                               | Install and configure PM2 log rotation |

To run it long-term, use PM2 (`npm install -g pm2`, then `npm run pm2`).
After changing or updating dependencies, run `npm install` again so the patch is reapplied.
