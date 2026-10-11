# Telegram LP Assistant — Design

Date: 2026-10-11 (WIB)
Status: draft, awaiting review

## 1. Goal

Turn meteorabot-v3 from an automated trading bot into a **Telegram liquidity assistant** for Meteora DLMM on
Solana. The owner drives everything from chat: open concentrated liquidity with SOL, claim fees, set TP/SL/Trail,
close, and track PnL (USD). The existing automation (auto-entry, deterministic exit, DCA) stays in the code but is
switchable on/off from Telegram.

### Decisions already made

| Topic | Decision |
|---|---|
| Users | Single user only: the owner's `TELEGRAM_CHAT_ID`, one wallet. Other chats are ignored and logged. |
| Telegram library | grammY (new dependency), long polling, one process together with the monitors. |
| PnL basis | USD (Meteora `pnlUsd` / USD deposits). `SOL_MODE=false` in `strat.conf`. |
| SOL → two-sided range | Swap part of the deposit SOL to the token via Jupiter, amount computed from the shape and range. |
| Shapes | `spot` (default), `curve`, `bid_ask`, `mixed` (= 70% of deposit as bid_ask + 30% as spot, same range, same position(s)). |
| Deposit buttons | `0.5` `0.7` `0.9` `1` `Custom`. No default deposit. |
| Range presets | 6 presets + custom (see §4.3). Custom values are percentages. |
| Auto Exit defaults | TP +15%, SL −25%, Trail start +5% / distance 3 points. Editable in `/settings`; per trade in `/positions`. |
| Deterministic exit | When ON it applies to all positions, manual included, alongside TP/SL/Trail. First trigger wins. |
| DCA | Only for positions opened by auto-entry (as today). Never for manual positions. |
| Toggles at first start | Auto Exit ON; Auto-entry, Deterministic exit, DCA OFF. |
| Flex cards | Metlex hand-off: close tx (tap-to-copy) + "Open Metlex" button. metlex.io/pnl-cards has no API or URL params; the user pastes the tx there. |
| Wallet key | Simple mode: export = message auto-deleted after 60 s; import = user message deleted immediately, key saved to git-ignored `wallet.key`, which overrides `.env`. |
| Times | Shown in WIB (UTC+7). |

### Out of scope

Multi-user, encrypted key storage, QR codes, bot-drawn flex cards, headless-browser automation of Metlex,
non-SOL pairs, migrating old SOL-based `pnl-history.json` into the new USD PnL view.

## 2. Architecture

One process (`npm start` → `src/index.js`) runs:

1. The **grammY bot** (commands, buttons, wizards).
2. The **exit loop** (`src/exit/index.js`), now trade-based: TP/SL/Trail always; deterministic rules when toggled ON.
3. The optional **auto-entry scanner** and **DCA watcher**. Both always start but check their toggle each tick, so
   switching them takes effect without a restart.

Everything stays in one process because the components share `state.json`.

### File layout

```
src/
  tg/                    NEW — all chat code (grammY)
    bot.js               create Bot, chat-ID guard, register commands (setMyCommands), start polling, error guard
    start.js             /start main menu + wallet card
    help.js              /help
    open-wizard.js       /open + pasted address → pool → deposit → range → shape → confirm → execute
    positions.js         /positions list + trade detail: claim, TP/SL/Trail, close
    pnl.js               /pnl Today/Week/Month + recent closes + Metlex hand-off
    wallet.js            /wallet deposit, withdraw, export, import
    settings.js          /settings toggles + Auto Exit defaults
    session.js           in-memory wizard/prompt state (single user), 10-min expiry, one-shot confirm tokens
    format.js            pure text/number formatting
  lp/                    NEW — LP actions, no Telegram code
    range.js             presets, custom parsing, % → bin ids (pure)
    pool-lookup.js       address → pool or mint → top SOL pools (Meteora datapi)
    open-trade.js        price guard, swap, open 1..N positions, mixed layering, revert on failure
    claim.js             claim fees for all positions of a trade (+ optional swap to SOL)
    close-trade.js       close all positions of a trade (+ optional swap to SOL), record result
  state/
    trades.js            NEW — trade records, locks, adoption of untracked positions
    settings.js          NEW — settings.json (toggles + Auto Exit defaults)
  exit/
    trade-exit.js        NEW — pure TP/SL/Trail evaluation
    index.js             CHANGED — iterate trades; TP/SL/Trail + optional deterministic rules
  solana/
    wallet.js            CHANGED — load wallet.key before .env; reloadWallet() after import
    transfer.js          NEW — SOL withdraw
  notify/telegram.js     CHANGED — close alert adds close tx + Metlex button; startup message → short "online" + menu
  index.js               CHANGED — start grammY bot; toggles gate entry/DCA
```

Unchanged in behaviour: `src/entry/*` (scanner, execute, DCA), `src/exit/rules.js`, `src/exit/classify.js`,
`src/solana/swap.js`, `src/solana/send.js`, `src/meteora/*`. They are only wrapped/gated.

New git-ignored runtime files: `settings.json`, `wallet.key`. Both get test overrides via env
(`SETTINGS_FILE`, `WALLET_KEY_FILE`), following the existing `STATE_FILE` pattern.

## 3. Data model

### Trade (`state.json` → `trades` map, next to existing `positions`)

```js
{
  id: 12,                       // short incrementing number, shown as #12
  pool, pair, baseMint,
  positions: ["<addr>", ...],   // 1..N on-chain positions
  shape: "spot" | "curve" | "bid_ask" | "mixed" | null,   // null for adopted/auto
  range: { belowPct, abovePct, lowerBin, upperBin } | null,
  depositSol, depositUsd,       // at open (depositUsd from Meteora deposits once indexed)
  origin: "manual" | "auto" | "external",
  openedAt,                     // ms
  exit: {
    tp:    { on, pct },         // close when PnL >= pct
    sl:    { on, pct },         // close when PnL <= -pct (pct stored positive)
    trail: { on, startPct, distancePct },
  },
  peakPnlPct, trailArmed,
  closed, closedAt, closeReason, closePnlUsd, closePnlPct, closeTx,
}
```

- **Manual** trades: created by the open wizard. `exit` = Auto Exit defaults when Auto Exit is ON, else all off.
- **Auto** trades: auto-entry/DCA positions are wrapped as one-position trades when `trackPosition` runs.
  `exit` = Auto Exit defaults when ON.
- **External** trades: on-chain positions owned by the wallet but unknown to state are adopted on the exit loop's
  position refresh as one-position trades with `exit` all off.
- Existing per-position state (`state.positions`) remains the store for the deterministic engine (OOR timers,
  trailing, DCA fields). A trade references positions; it does not replace that map.

### Settings (`settings.json`)

```js
{
  autoExit: true, autoEntry: false, deterministicExit: false, dca: false,
  exitDefaults: { tpPct: 15, slPct: 25, trailStartPct: 5, trailDistancePct: 3 }
}
```

Created on first start with these values. After that, the four toggles in `settings.json` win over
`ENTRY_ENABLED` / `DCA_ENABLED` in `strat.conf`. All other tuning stays in `strat.conf`.

## 4. Flows

### 4.1 `/start`

Wallet card: address (tap to copy), SOL balance + USD, open trades count, total open PnL (USD), toggles ON,
`DRY RUN` badge when set. Buttons: `➕ Open` `📂 Positions` `📊 PnL` `👛 Wallet` `⚙️ Settings` `❓ Help`.
On process start the bot sends a short "online" message with this menu, replacing the old long startup message.

### 4.2 Pool selection (`/open` or pasted address)

- `/open` → "Send a pool address or token mint". Any base58 string of 32–44 chars sent outside a prompt also
  starts the wizard.
- Account owner is the DLMM program → pool. Otherwise treat as a mint → query Meteora datapi pools by the mint,
  keep SOL-quoted pools, show the top 5 by TVL as buttons (`binStep · fee · TVL · 24h vol`).
- Non-SOL pair → rejected with a message, as today.
- Pool card: pair, current price, bin step, base fee, TVL.

### 4.3 Deposit → range → shape → confirm

**Deposit:** buttons `0.5` `0.7` `0.9` `1` `Custom`. Check: balance ≥ deposit + 0.08 SOL buffer + rent for
positions beyond the first. If short, show the shortfall and stop.

**Range:**

| Preset | Below / Above | Swap |
|---|---|---|
| Narrow | −20% / +20% | yes |
| Balanced | −45% / +45% | yes |
| Wide | −65% / +65% | yes |
| Narrow SOL | −20% / 0 | no |
| Balanced SOL | −45% / 0 | no |
| Wide SOL | −65% / 0 | no |
| Custom | `45` → −45% / 0 (SOL only); `45 10` → −45% / +10% (swap) | depends |

Rules: below in (0, 99]; above in [0, 1000]; anything else → "invalid, try again".

Conversion (token price in SOL, step factor `f = 1 + binStep/10000`):
`binsBelow = floor(ln(1 − below/100) / −ln f)`, `binsAbove = floor(ln(1 + above/100) / ln f)`.
When the base token is X: `lower = active − binsBelow`, `upper = active + binsAbove`.
When SOL is X (token price is inverted in bin terms): `lower = active − binsAbove`, `upper = active + binsBelow`.
SOL-only ranges end at the active bin on the SOL side.

**Shape:** `spot` `curve` `bid_ask` `mixed`. Mapped to SDK `StrategyType.Spot/Curve/BidAsk`. Mixed = BidAsk 70% then
Spot 30%.

**Confirm screen:** pair · deposit · range as % and as prices · bin count · number of on-chain positions · shape ·
SOL to be swapped · refundable rent · TP/SL/Trail to be attached. Buttons `✅ Confirm` `◀ Back` `✖ Cancel`.

### 4.4 Execution (`lp/open-trade.js`)

1. Price guard: reuse `guardPoolPrice` (pool vs Jupiter deviation). Exhausted → stop with message.
2. Two-sided only: compute the token amount the upper bins need using the SDK auto-fill helpers
   (`autoFillXByStrategy` / `autoFillYByStrategy`) for the chosen shape and range; split the deposit so the
   SOL side + swapped token value = deposit; buy the token with `swapSolToToken`. For mixed, compute per part.
3. Open:
   - Range fits one position → `initializePositionAndAddLiquidityByStrategy`.
   - Larger → SDK multi-position call (`initializeMultiplePositionAndAddLiquidityByStrategy2`), all addresses saved
     under one trade.
   - Mixed → open with BidAsk (70%), then `addLiquidityByStrategy` Spot (30%) into the same position(s).
4. Sending uses `buildFeePlan` / `checkFeeCap` / `sendAndConfirmRobust` (existing `ENTRY_FEE_MODE` etc.).
5. Failure: if the position account exists on-chain → treat as success (existing recovery pattern). If nothing
   landed → swap bought token back to SOL.
6. Progress is shown by editing the wizard message. Done → "✅ Opened #12" card with `Manage` button.
7. `DRY_RUN`: everything up to step 3 is computed and shown; no swap or transaction is sent.

### 4.5 `/positions`

List: one line per open trade, e.g.
`#12 BONK-SOL · spot · 0.5 SOL · +4.2% ($3.10) · in range · TP15 SL-25 T5/3`.

Detail card: range & prices, position count, unclaimed fees (USD), PnL & peak, exit settings, origin. Buttons:
`💰 Claim` `💰 Claim+swap` · `🎯 TP` `🛑 SL` `📈 Trail` · `❌ Close` · `🔄 Refresh` `◀ Back`.

- TP prompt: `15` or `off`. SL prompt: `25` or `off`. Trail prompt: `5 3` or `off`.
- Close: `Close + swap to SOL` (default) / `Close only` / `Cancel`.
- Claim: claim fees on every position of the trade; `Claim+swap` then swaps the claimed token to SOL.

### 4.6 Exit loop (`exit/index.js`, existing cadence)

For each open, unlocked trade:

1. Fetch PnL (Meteora `status=open`, per pool, cached as today). Trade PnL % = Σ `pnlUsd` ÷ Σ USD deposits
   × 100, unclaimed fees included. Update `peakPnlPct`.
2. `evaluateTradeExit(trade, pnlPct)` (pure):
   - TP: `tp.on && pnl >= tp.pct` → `tp`
   - SL: `sl.on && pnl <= -sl.pct` → `sl`
   - Trail: once `pnl >= trail.startPct` set `trailArmed`; while armed, `pnl <= peak − distancePct` → `trail`
3. If Deterministic exit is ON: run existing `evaluateExit` per position; any `close` → close the whole trade.
   Follow-up actions (spot OOR-left token fallback, spot OOR-right re-entry) run only for one-position trades.
4. Before any automatic close: re-fetch PnL once (forced) and re-evaluate; close only if still triggered.
5. Close via `lp/close-trade.js` with swap → record result → alert.

### 4.7 `/pnl`

Tabs `Today` `Week` `Month`, calendar-based in WIB (00:00 today, Monday 00:00, 1st 00:00). Shows realized USD
profit (closed trades), trade count, win rate, best/worst trade, and unrealized PnL of open trades.
`🧾 Recent closes` → last 10 closed trades with close tx (tap to copy) and `🖼 Open Metlex`
(`https://www.metlex.io/pnl-cards`). Only trades closed by this version are counted.

### 4.8 `/wallet`

Card: address, SOL balance, token holdings with USD value.

- `📥 Deposit` → address as tap-to-copy text.
- `📤 Withdraw` → destination address → amount or `max` (balance − 0.01 SOL fee buffer) → confirm → send.
- `🔑 Export` → warning → `I understand` → key sent; bot deletes that message after 60 s.
- `📲 Import` → refused while any trade is open. Otherwise prompt → user pastes key → bot deletes the user's
  message immediately → validates (base58, 64-byte secret key) → writes `wallet.key` → `reloadWallet()` → shows
  new address.

### 4.9 `/settings`

Toggles: Auto Exit · Auto-entry · Deterministic exit · DCA (✅/❌ buttons). Auto Exit defaults: `TP 15`
`SL 25` `Trail 5 / 3`, tap to edit (same prompts as §4.5). `DRY_RUN` shown read-only.

### 4.10 `/help`

Short how-to per flow and the command list. Commands are registered with `setMyCommands`.

### 4.11 Alerts

Existing alerts keep working. Close alerts (manual or automatic) show reason, PnL USD/%, duration, close tx
(tap to copy) and `🖼 Open Metlex`.

## 5. Error handling

- Every handler is wrapped: failure → `⚠️ <action> failed: <reason>`, logged, process keeps running.
- Per-trade lock (in-memory only, `Map<tradeId, "claim"|"close"|"exit">`) during claim/close/exit. Other actions
  on a locked trade answer "busy"; the exit loop skips locked trades. Not persisted, so a crash never leaves a
  trade stuck.
- Confirm buttons carry a one-shot token; reuse or post-restart taps answer "expired — start again".
- Wizards and prompts expire after 10 minutes of inactivity.
- External API failures (Meteora, Jupiter, RPC) are shown as errors; the exit loop retries next tick.

## 6. Testing

`node --test`, existing style. Tests use env overrides (`STATE_FILE`, `SETTINGS_FILE`, `WALLET_KEY_FILE`, …).

- Pure: `% → bin` (both orientations), custom range parsing, TP/SL/Trail decisions, multi-position PnL
  aggregation, WIB day/week/month boundaries, formatting.
- State: trade lifecycle, adoption of external positions, settings first-start defaults + persistence, locks.
- Handlers with a fake grammY context: foreign chat ignored, import deletes the user message, expired confirm
  refused.
- `test/smoke.test.js` `MODULES` updated with every new file.
- Manual per stage: `DRY_RUN=true` end-to-end in Telegram, then live with a small custom deposit.

## 7. Build order

1. **Foundation** — grammY bot, chat-ID guard, `/start`, `/help`, `/settings`, `settings.json`, toggles gating
   auto-entry / deterministic exit / DCA, `SOL_MODE=false`.
2. **Trades & `/positions`** — trade store, adoption, claim, TP/SL/Trail, close, trade-based exit loop.
3. **`/open` wizard** — single position first, then multi-position ranges and mixed.
4. **`/pnl`** + Metlex hand-off.
5. **`/wallet`** — deposit, withdraw, export, import.

Each stage ends with `npm run lint`, `npm test`, and a DRY_RUN check before the next starts.

## 8. Docs to update

`README.md`, `PROJECT_STRUCTURE.md`, `AGENTS.md` snapshot, `.env.example` (no new secrets; mention `wallet.key`),
`.gitignore` (`settings.json`, `wallet.key`).
