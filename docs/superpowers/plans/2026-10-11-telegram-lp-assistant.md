# Telegram LP Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn meteorabot-v3 into a single-user Telegram assistant that opens Meteora DLMM liquidity with SOL, claims fees, manages TP/SL/Trail, closes trades and reports USD PnL, with the old auto-entry / deterministic exit / DCA kept behind toggles.

**Architecture:** One Node process. A grammY bot (`src/tg/`) drives chat. Telegram-free LP actions live in `src/lp/`. A new "trade" record (`src/state/trades.js`) groups 1..N on-chain positions. The existing exit loop becomes trade-aware: TP/SL/Trail always run, and the old rule engine runs only when toggled ON. Toggles live in `settings.json`.

**Tech Stack:** Node ESM (no build step), grammY, `@meteora-ag/dlmm` 1.9.x, `@solana/web3.js` 1.x, Jupiter (existing `src/solana/swap.js`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-11-telegram-lp-assistant-design.md`

## Global Constraints

- Single user: only `config.telegramChatId` is answered; every other chat is ignored and logged with `log.warn`.
- PnL is USD: `strat.conf` `SOL_MODE=false`. Trade PnL % = Σ `pnlUsd` ÷ Σ deposit USD × 100.
- Deposit buttons exactly `0.5` `0.7` `0.9` `1` `Custom`. No default deposit.
- Balance check before opening: balance ≥ deposit + `0.08` SOL buffer + rent of positions beyond the first.
- Range presets: Narrow 20/20, Balanced 45/45, Wide 65/65, Narrow SOL 20/0, Balanced SOL 45/0, Wide SOL 65/0. Custom `45` → 45/0; `45 10` → 45/10. Below in (0, 99], above in [0, 1000].
- Shapes: `spot` (default), `curve`, `bid_ask`, `mixed` = 70% BidAsk then 30% Spot on the same position(s).
- Auto Exit defaults: TP 15, SL 25, Trail start 5 / distance 3.
- `settings.json` first-start values: `autoExit: true, autoEntry: false, deterministicExit: false, dca: false`. After first start these four win over `strat.conf` `ENTRY_ENABLED` / `DCA_ENABLED`.
- Metlex hand-off URL: `https://www.metlex.io/pnl-cards`. Close tx shown as tap-to-copy (`<code>` in HTML parse mode).
- Wallet export message is deleted after 60 s. Import is refused while any trade is open; the user's key message is deleted immediately.
- Wizards, prompts and confirm tokens expire after 10 minutes (600 000 ms). Confirm tokens are one-shot.
- New UI text is English. Times are shown in WIB (UTC+7).
- New runtime files `settings.json` and `wallet.key` are git-ignored, with test overrides `SETTINGS_FILE` and `WALLET_KEY_FILE` (same pattern as `STATE_FILE` in `src/core/paths.js`).
- Every new module is added to `MODULES` in `test/smoke.test.js`.
- Style: Prettier `printWidth: 120`, double quotes. `npm run lint` and `npm test` pass at the end of every task.
- AGENTS.md: **never commit without the user's approval.** Each task ends with a checkpoint (show `git status` + `git diff --stat`) and *offers* a commit; it does not commit on its own.
- `DRY_RUN=true` must never send a transaction or swap (existing `config.dryRun` guards in `swap.js` / `close.js` stay; new on-chain code checks it too).

## Review Focus

1. **Double tap on Confirm / Close / Claim** → exactly one on-chain action. Pinned by one-shot token tests (Task 3) and trade-lock tests (Task 5).
2. **PnL not indexed yet for a just-opened position** (Meteora has no entry yet) → trade PnL is *unknown*, not 0%, and no TP/SL/Trail fires. Pinned in Task 6.
3. **A pasted address that is neither a pool nor a token** (wallet address, random base58, Solscan URL, text around the address) → address extracted when present, "not a DLMM pool or token" otherwise. Pinned in Tasks 9 and 11.
4. **One leg of a multi-position trade closed outside the bot** → the trade stays open with the remaining legs; when every leg is gone the trade is settled as `closed_outside`. Pinned in Task 8.
5. **Not enough SOL** (deposit + buffer + extra rent > balance) → refused before any swap, with the shortfall shown. Pinned in Task 12.

---

## Stage 1 — Foundation

### Task 1: Settings store + USD PnL switch

**Files:**
- Modify: `src/core/paths.js` (add `SETTINGS_FILE`, `WALLET_KEY_FILE`)
- Create: `src/state/settings.js`
- Modify: `strat.conf` (`SOL_MODE=false`, comment: PnL in USD)
- Modify: `.gitignore` (add `settings.json`, `wallet.key`)
- Test: `test/settings.test.js`, `test/smoke.test.js`

**Interfaces:**
- Produces:
  - `SETTINGS_FILE`, `WALLET_KEY_FILE` (paths, env-overridable)
  - `TOGGLES = ["autoExit", "autoEntry", "deterministicExit", "dca"]`
  - `DEFAULT_SETTINGS = { autoExit: true, autoEntry: false, deterministicExit: false, dca: false, exitDefaults: { tpPct: 15, slPct: 25, trailStartPct: 5, trailDistancePct: 3 } }`
  - `getSettings(): Settings` — reads the file; missing → writes and returns `DEFAULT_SETTINGS`; unknown/missing keys filled from defaults.
  - `isOn(name: string): boolean`
  - `setToggle(name, on: boolean): Settings` — throws on unknown name.
  - `setExitDefaults(partial): Settings` — merges `{tpPct?, slPct?, trailStartPct?, trailDistancePct?}`.
  - `exitPresetForNewTrade(): Exit` — Auto Exit ON → `{ tp:{on:true,pct:15}, sl:{on:true,pct:25}, trail:{on:true,startPct:5,distancePct:3} }` from current defaults; OFF → the same shape with every `on:false`.

- [ ] **Step 1: Write failing tests** in `test/settings.test.js` (set `process.env.SETTINGS_FILE` to a temp file before importing):
  - `first read creates defaults` → `getSettings()` deep-equals `DEFAULT_SETTINGS` and the file exists.
  - `toggle persists` → `setToggle("dca", true)`; a fresh `JSON.parse` of the file has `dca === true`; `isOn("dca") === true`.
  - `unknown toggle throws` → `assert.throws(() => setToggle("nope", true))`.
  - `exit defaults merge` → `setExitDefaults({ tpPct: 20 })` keeps `slPct === 25`.
  - `preset follows autoExit` → with autoExit ON, `exitPresetForNewTrade().trail` equals `{ on: true, startPct: 5, distancePct: 3 }`; after `setToggle("autoExit", false)`, every `.on` is `false`.
  - `corrupt file falls back to defaults` → write `"{oops"`; `getSettings().autoExit === true`.
- [ ] **Step 2:** `node --test test/settings.test.js` → FAIL (module not found).
- [ ] **Step 3:** Implement `src/state/settings.js` and the paths, `strat.conf` and `.gitignore` changes. Add `../src/state/settings.js` to `MODULES`.
- [ ] **Step 4:** `node --test test/settings.test.js test/smoke.test.js` → PASS. Then `npm run lint && npm test` → PASS.
- [ ] **Step 5: Checkpoint** — show `git status` + `git diff --stat`, offer commit `feat(settings): toggles + Auto Exit defaults in settings.json; PnL in USD`.

### Task 2: Toggles gate auto-entry, DCA

**Files:**
- Modify: `src/entry/index.js:85` and `:190` (`config.entry.enabled` → `isOn("autoEntry")`)
- Modify: `src/entry/dca.js:45` (`cfg.enabled` → `isOn("dca")`)
- Modify: `src/exit/index.js` — every `config.dca.enabled` read → `isOn("dca")`
- Modify: `src/exit/close.js` — `config.dca.enabled` → `isOn("dca")`
- Test: `test/toggles.test.js`

**Interfaces:**
- Consumes: `isOn` (Task 1).
- Produces: auto-entry and DCA follow the toggles live, without a restart. Deterministic exit is gated in Task 8.

- [ ] **Step 1: Write failing tests** (temp `SETTINGS_FILE` + `STATE_FILE`):
  - `refreshCandidates returns null when autoEntry off` → `await refreshCandidates() === null`.
  - `watchAndEnter returns null when autoEntry off`.
  - `tickDca does nothing when dca off` → with one eligible tracked position in the temp state, `tickDca()` resolves and the state file is byte-identical afterwards.
- [ ] **Step 2:** Run → FAIL (still reads `config.*.enabled`, which is `true` in `strat.conf`).
- [ ] **Step 3:** Replace the reads listed above. `src/index.js` keeps calling `startEntryScanner()` and `startDcaWatcher()` unconditionally (they check the toggle each tick).
- [ ] **Step 4:** `node --test test/toggles.test.js` → PASS; `npm run lint && npm test` → PASS (update any existing test that relied on `config.dca.enabled` by setting the toggle via `setToggle` in that test).
- [ ] **Step 5: Checkpoint** — offer commit `feat(settings): auto-entry and DCA follow Telegram toggles`.

### Task 3: grammY core — bot, guard, session, formatting

**Files:**
- Modify: `package.json` (`npm install grammy@^1.46.0`, then re-run `npm install` so `postinstall` patches still apply)
- Create: `src/tg/bot.js`, `src/tg/session.js`, `src/tg/format.js`
- Test: `test/tg-bot.test.js`, `test/tg-session.test.js`, `test/tg-format.test.js`, `test/smoke.test.js`

**Interfaces:**
- Produces:
  - `src/tg/bot.js`
    - `COMMANDS = [{command:"start",…},{command:"open",…},{command:"positions",…},{command:"pnl",…},{command:"wallet",…},{command:"settings",…},{command:"help",…}]` (descriptions: "Main menu + wallet card", "Open LP from token mint or pool address", "Claim, set TP/SL/Trail, close", "Profit today / week / month", "Deposit, withdraw, export or import key", "Toggles and Auto Exit defaults", "How-to and command list").
    - `createBot({ token, chatId, modules = [] }): Bot` — installs the chat guard first (drops updates whose `ctx.chat?.id` ≠ `chatId`, `log.warn` with the foreign id), then calls `m.register(bot)` for each module, then a final `bot.on("message:text")` router (Task 9/13 fill it), then `bot.catch(err => log.error(...))`.
    - `withGuard(handler)` — wraps a handler: on throw, logs and replies `⚠️ <label> failed: <first line of error>`; for callback queries it always calls `ctx.answerCallbackQuery()`.
    - `startBot(modules): Promise<Bot>` — `createBot` with `config.telegramBotToken` / `config.telegramChatId`, `await bot.api.setMyCommands(COMMANDS)`, `bot.start({ drop_pending_updates: true })` (not awaited). Returns `null` (with a warning) when token or chat id is missing.
  - `src/tg/session.js` (in-memory, single user, `TTL_MS = 600000`)
    - `put(key, value, ttlMs = TTL_MS)`, `get(key)` (null if expired), `take(key)` (get + delete), `del(key)`
    - `issueToken(payload, ttlMs = TTL_MS): string` (8 random base36 chars); `redeemToken(token): payload | null` (one-shot; expired → null)
    - Callback data convention: `"<area>:<action>[:<arg>]"`, ≤ 64 bytes; confirm buttons use `"ok:<token>"`.
  - `src/tg/format.js` (pure)
    - `fmtUsd(n)` → `"$3.10"`, `"-$3.10"`, `null` → `"?"`
    - `fmtPct(n)` → `"+4.20%"`, `"-1.00%"`, `null` → `"?"`
    - `fmtSol(n)` → `"0.5 SOL"` (up to 4 decimals, trailing zeros trimmed)
    - `shortAddr(a)` → first 4 + `"…"` + last 4
    - `fmtWib(ms)` → `"2026-10-11 09:01 WIB"`
    - `exitSummary(exit)` → `"TP15 SL-25 T5/3"`, parts omitted when off, `"no exits"` when all off
    - `esc(s)` — HTML-escape for `parse_mode: "HTML"`

- [ ] **Step 1: Write failing tests**
  - `tg-bot.test.js` (build a `Bot` with a dummy token and `botInfo` passed so no network; feed updates with `bot.handleUpdate(update)`, stub `bot.api.config.use` to capture outgoing calls):
    - `foreign chat is ignored` → a `/start` update from chat 999 produces no API calls and a registered spy handler is not invoked.
    - `owner chat reaches handlers` → same update from the configured chat id invokes the spy.
    - `withGuard replies on throw` → handler throws `new Error("boom\nstack")`; the captured `sendMessage` text is `"⚠️ test failed: boom"`.
  - `tg-session.test.js`:
    - `token is one-shot` → `redeemToken(t)` returns the payload, a second call returns `null`.
    - `token expires` → `issueToken(p, 1)`; after `await sleep(5)` → `null`.
    - `put/get expiry` and `take deletes`.
  - `tg-format.test.js`: one assertion per formatter using the examples above; `fmtWib(Date.UTC(2026, 9, 11, 2, 1))` → `"2026-10-11 09:01 WIB"`.
- [ ] **Step 2:** Run the three files → FAIL.
- [ ] **Step 3:** Install grammY and implement the three modules. Add them to `MODULES`.
- [ ] **Step 4:** Run the three files → PASS; `npm run lint && npm test` → PASS.
- [ ] **Step 5: Checkpoint** — offer commit `feat(tg): grammY bot core with chat guard, session, formatting`.

### Task 4: `/start`, `/help`, `/settings` + wiring in `src/index.js`

**Files:**
- Create: `src/tg/start.js`, `src/tg/help.js`, `src/tg/settings.js`
- Modify: `src/index.js` (start the bot; replace `tg.notifyStartup(...)` with the home card sent via the bot)
- Modify: `src/notify/telegram.js` (`send(text, extra = {})` passes `extra.reply_markup` / `extra.parse_mode`; delete `notifyStartup` and update its test)
- Test: `test/tg-start.test.js`, `test/tg-settings.test.js`

**Interfaces:**
- Consumes: `createBot`, `withGuard`, `session`, `format` (Task 3); `getSettings`, `setToggle`, `setExitDefaults` (Task 1).
- Produces:
  - `buildHome({ address, balanceSol, solUsd, openTrades, openPnlUsd, settings, dryRun }): { text, keyboard }` (pure). Text has the address in `<code>`, SOL + USD, open trades count, open PnL, the ON toggles, and `🧪 DRY RUN` when `dryRun`. Keyboard rows: `➕ Open`(`home:open`) `📂 Positions`(`home:positions`) / `📊 PnL`(`home:pnl`) `👛 Wallet`(`home:wallet`) / `⚙️ Settings`(`home:settings`) `❓ Help`(`home:help`).
  - `sendHome(ctxOrApi)` — gathers live data (`getWallet()`, `connection.getBalance`, `getPrice(WSOL_MINT)`, `listOpenTrades()` once Task 5 exists; before that `openTrades = 0`) and sends `buildHome`.
  - `buildSettings(settings, dryRun): { text, keyboard }` (pure). One button per toggle `"✅ Auto Exit"` / `"❌ Auto Exit"` → `set:toggle:<name>`; `🎯 TP 15` → `set:edit:tp`, `🛑 SL 25` → `set:edit:sl`, `📈 Trail 5 / 3` → `set:edit:trail`; `DRY_RUN: on/off (.env)` as text only.
  - `HELP_TEXT` — how-to per flow (open, positions, pnl, wallet, settings, paste a CA) + command list.
  - Each file exports `register(bot)`.
  - `set:edit:*` stores prompt `{ kind: "settings-exit", field }`; the text answer is parsed by `parseExitInput` (Task 9). Until Task 9 lands, wire the prompt and parse with a local stub that accepts a plain positive number.

- [ ] **Step 1: Write failing tests**
  - `buildHome shows DRY RUN badge and toggles` → `text` includes `"DRY RUN"` and `"Auto Exit"`, and does not include `"DCA"` when dca is off.
  - `buildHome keyboard callback data` → flattened callback data equals `["home:open","home:positions","home:pnl","home:wallet","home:settings","home:help"]`.
  - `settings toggle button flips the setting` → feed a `callback_query` with data `set:toggle:dca` through a bot from `createBot({ modules: [settingsModule] })`; afterwards `isOn("dca") === true` and an `editMessageText` call was captured.
  - `buildSettings labels` → contains `"🎯 TP 15"` and `"📈 Trail 5 / 3"`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. In `src/index.js`: after the wallet check, `const bot = await startBot([start, help, settings])` and `if (bot) await sendHome(bot.api)` with the text prefixed `🟢 Online`. Keep the existing scanner / DCA / `mainLoop` starts.
- [ ] **Step 4:** `npm run lint && npm test` → PASS. Manual: `DRY_RUN=true npm start`; in Telegram `/start`, `/help`, `/settings`, toggle DCA twice; `settings.json` reflects it; a message from another account gets no reply.
- [ ] **Step 5: Checkpoint** — offer commit `feat(tg): /start, /help, /settings with live toggles`.

---

## Stage 2 — Trades & `/positions`

### Task 5: Trade store + locks

**Files:**
- Create: `src/state/trades.js`
- Modify: `src/state/positions.js` `recordClose(positionAddress, reason, pnlPct, extra = {})` also stores `closePnlUsd: extra.pnlUsd ?? null` and `closeTx: extra.closeTx ?? null`
- Test: `test/trades.test.js`

**Interfaces:**
- Consumes: `readState`, `writeState` (`src/state/store.js`); `getTrackedPosition` (`src/state/positions.js`).
- Produces (all on `state.trades` keyed by id string, counter `state.nextTradeId` starting at 1):
  - `createTrade({ pool, pair, baseMint, positions, shape = null, range = null, depositSol = null, origin, exit }): Trade` — sets `id`, `openedAt: Date.now()`, `depositUsd: null`, `peakPnlPct: null`, `trailArmed: false`, `closed: false`, close fields null.
  - `getTrade(id)`, `listOpenTrades(): Trade[]` (by id asc), `listClosedTrades({ sinceMs = 0, untilMs = Infinity } = {}): Trade[]` (by `closedAt`)
  - `findTradeByPosition(address): Trade | null` (open trades only)
  - `setTradeExit(id, partialExit)` — shallow-merges per key (`tp`, `sl`, `trail`); setting `trail` resets `trailArmed=false`, `peakPnlPct=null`.
  - `updateTradeProgress(id, { peakPnlPct, trailArmed })`
  - `setTradeDepositUsd(id, usd)`
  - `settleTradeIfDone(id, { fallbackReason = "closed_outside" } = {}): Trade | null` — when every leg in `state.positions` has `closed === true`: marks the trade closed with `closedAt = max leg closedAt`, `closeReason` = the last leg's `closeReason` (or `fallbackReason` when null / `closed_not_detected`), `closePnlUsd = Σ leg closePnlUsd` (null if any is null), `closePnlPct = closePnlUsd / depositUsd × 100` (null if unknown), `closeTx` = last leg's `closeTx`. Returns the settled trade, else `null`.
  - Locks (in-memory `Map`, never persisted): `tryLockTrade(id, kind): boolean`, `unlockTrade(id)`, `tradeLock(id): string | null`.

- [ ] **Step 1: Write failing tests** (temp `STATE_FILE`):
  - `ids increment` → two creates give ids 1 and 2.
  - `findTradeByPosition` finds an open trade and returns null after it is settled.
  - `setTradeExit trail resets arming`.
  - `settle waits for every leg` → trade with legs A, B; `recordClose(A, "tp", 5, { pnlUsd: 2 })` → `settleTradeIfDone` returns null; `recordClose(B, "tp", 1, { pnlUsd: 1, closeTx: "sig" })` → returns trade with `closePnlUsd === 3`, `closeTx === "sig"`; with `depositUsd = 100` → `closePnlPct === 3`.
  - `settle uses fallback for closed_not_detected` → reason `"closed_outside"`, `closePnlUsd === null`.
  - `lock is exclusive` → `tryLockTrade(1, "close") === true`, second `tryLockTrade(1, "claim") === false`, `tradeLock(1) === "close"`, after `unlockTrade(1)` lock succeeds again.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Checkpoint** — offer commit `feat(state): trade records with locks and settlement`.

### Task 6: USD PnL per position + TP/SL/Trail evaluation

**Files:**
- Modify: `src/meteora/positions.js` `enrichPnl` — also set `p.pnlUsd = Number(entry.pnlUsd)`, `p.depositUsd = Number(entry.allTimeDeposits?.total?.usd)`, `p.unclaimedFeeUsd` (Σ `unrealizedPnl.unclaimedFeeTokenX/Y.amountUsd`, if present), `p.pnlKnown = true`. Positions with no entry keep `pnlKnown` undefined.
- Modify: `src/meteora/positions.js` — add `waitClosedPositionEntry(pool, position, opts)` (same polling as `waitClosedPositionPnl`, returns the raw entry or null); `waitClosedPositionPnl` becomes `pnlFromEntry(await waitClosedPositionEntry(...))`.
- Create: `src/exit/trade-exit.js`
- Test: `test/trade-exit.test.js`

**Interfaces:**
- Produces:
  - `aggregateTradePnl(trade, positionsByAddr: Map<string, {pnlUsd, depositUsd, pnlKnown}>): { pnlUsd, depositUsd, pnlPct } | null` — null if any open leg is missing or `pnlKnown !== true` or Σ depositUsd ≤ 0.
  - `evaluateTradeExit(trade, pnlPct): { reason: "tp" | "sl" | "trail" | null, peakPnlPct, trailArmed }` — pure. `pnlPct == null` → `{ reason: null, peakPnlPct: trade.peakPnlPct, trailArmed: trade.trailArmed }`. Order: SL, TP, Trail. Peak = max(previous peak, pnl). Trail arms when `pnl >= startPct`; armed and `pnl <= peak − distancePct` → `"trail"`.

- [ ] **Step 1: Write failing tests**
  - `aggregate sums legs` → legs `{pnlUsd: 2, depositUsd: 50}` and `{pnlUsd: 1, depositUsd: 50}` → `{ pnlUsd: 3, depositUsd: 100, pnlPct: 3 }`.
  - `aggregate unknown when a leg is not indexed` → one leg `pnlKnown` undefined → `null` (Review Focus 2).
  - `null pnl never triggers` → `evaluateTradeExit(tradeWithAllOn, null).reason === null`.
  - `tp at +15` → `15` → `"tp"`; `14.99` → `null`.
  - `sl at -25` → `-25` → `"sl"`.
  - `trail example` (start 5, distance 3) → feed 4 (not armed), 6 (armed, peak 6), 18 (peak 18), 15.5 → `null`, 15 → `"trail"`.
  - `off switches ignored` → all `on:false`, pnl `+500` and `-90` → `null`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add `src/exit/trade-exit.js` to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Checkpoint** — offer commit `feat(exit): USD trade PnL and TP/SL/Trail evaluation`.

### Task 7: Claim, close-trade, close alert with Metlex

**Files:**
- Create: `src/meteora/claim.js`, `src/lp/claim.js`, `src/lp/close-trade.js`
- Modify: `src/exit/close.js` `handleClose` — new opt `silent` (skip `tg.notifyClose`); use `waitClosedPositionEntry` to get `pnlPct` (`pnlFromEntry`) and `pnlUsd` (`Number(entry.pnlUsd)`, fallback `pos.pnlUsd`); call `recordClose(addr, reason, pnlPct, { pnlUsd, closeTx })` with `closeTx = result.txs?.at(-1) ?? null`; return `{ success, swapInfo, closeTx, pnlUsd, pnlPct }`.
- Modify: `src/notify/telegram.js` — `notifyClose(..., { closeTx } = {})` adds the tx in `<code>` + Metlex URL button; new `notifyTradeClosed(trade, { swapInfo })` (reason label via `exitLabel` + new labels `tp` → "Take Profit", `sl` → "Stop Loss", `trail` → "Trailing", `manual` → "Manual close", `closed_outside` → "Closed outside bot"; PnL USD + %; duration; tx; Metlex button).
- Test: `test/close-trade.test.js`, `test/telegram.test.js` (extend)

**Interfaces:**
- Consumes: Task 5 store + locks; `handleClose`; `swapToSol`, `getTokenBalance`.
- Produces:
  - `claimPositionFees(positionAddress): Promise<{ success, txs, dryRun?, error? }>` (`src/meteora/claim.js`) — finds the position's pool like `closePosition` does, `pool.claimSwapFee`, sends each tx with `sendAndConfirmRobust` (fee plan from `buildFeePlan()`); dry-run returns `{ success: true, dryRun: true, txs: [] }`.
  - `claimTrade(trade, { swap = false, deps } = {}): Promise<{ success, busy?, claimed, failed: string[], swapInfo }>` — locks `"claim"`; claims every leg; if `swap`, swaps the full `baseMint` balance once.
  - `closeTrade(trade, { reason, swap = true, positionsByAddr = new Map(), deps } = {}): Promise<{ success, busy?, trade?, failed: string[], swapInfo }>` — locks `"close"`; for each open leg calls `handleClose(pos, reason, { skipAutoSwap: true, silent: true, skipDeactivate: true })` where `pos` = the live position object (or `{ position, pool, pair, baseMint }` when not in the map); if `swap`, one `swapToSol(baseMint, balance)`; then `settleTradeIfDone`; when settled → `notifyTradeClosed`; always `unlockTrade` in `finally`. A leg failure leaves the trade open, lists the leg in `failed`, and returns `success: false`.
  - `deps` (tests only): `{ handleClose, swapToSol, getTokenBalance, notifyTradeClosed, claimPositionFees }`, defaulting to the real modules.

- [ ] **Step 1: Write failing tests** (temp `STATE_FILE`, fake deps)
  - `close settles and alerts once` → 2-leg trade, fake `handleClose` records closes via `recordClose`; result `success: true`; `notifyTradeClosed` called once; trade closed.
  - `swap happens once for all legs` → fake balance 100 → `swapToSol` called exactly once with `(baseMint, 100)`.
  - `close only does not swap` → `swap: false` → `swapToSol` not called.
  - `busy when locked` → `tryLockTrade(id, "claim")` first → `closeTrade` returns `{ success: false, busy: true }` and `handleClose` not called (Review Focus 1).
  - `leg failure keeps trade open` → second leg returns `{ success: false }` → `failed` lists it, trade not closed, lock released.
  - `claim swaps once when asked`.
  - `telegram.test.js`: `buildCloseMessage` with `closeTx` includes `<code>sig</code>`; `notifyTradeClosed` payload has `reply_markup.inline_keyboard[0][0].url === "https://www.metlex.io/pnl-cards"` (capture `send` via a test hook: export `__setSender(fn)` for tests).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add new modules to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Checkpoint** — offer commit `feat(lp): claim and close whole trades; close alert with Metlex hand-off`.

### Task 8: Trade-aware exit loop

**Files:**
- Modify: `src/exit/index.js` `mainLoop`
- Modify: `src/entry/execute.js` — after `trackPosition(...)`, `createTrade({ …, positions: [positionAddress], depositSol: sizeSol, origin: "auto", exit: exitPresetForNewTrade() })`
- Create: `src/exit/trade-loop.js` (the new per-tick trade logic, so `index.js` only calls it)
- Test: `test/trade-loop.test.js`

**Interfaces:**
- Consumes: Tasks 1, 5, 6, 7; `fetchPoolPnl(pool, { force: true })`.
- Produces:
  - `syncTrades(positions, { wasTracked: Set<string> })` — for each live position without a trade: `wasTracked.has(addr)` (bot already tracked it before this tick) → `origin: "auto"`, `exit: exitPresetForNewTrade()`; otherwise `origin: "external"`, every exit `on:false`. Sets `depositUsd` from Σ legs `depositUsd` when the trade's `depositUsd` is null and all legs are known. Then `settleTradeIfDone` for every open trade (handles legs closed by the old engine or outside the bot).
  - `runTradeExits(positions, { deps } = {}): Promise<Set<number>>` — for each open, unlocked trade: `aggregateTradePnl` → `evaluateTradeExit` → `updateTradeProgress`; on a reason: re-fetch PnL for the trade's pool with `force: true`, rebuild the map, re-aggregate, re-evaluate; still triggered → `closeTrade(trade, { reason, swap: true, positionsByAddr })`. Returns ids closed or locked this tick.
  - `mainLoop` order per tick: (1) capture `wasTracked` = addresses with `getTrackedPosition` before tracking; (2) existing tracking/mode code; (3) `syncTrades`; (4) `runTradeExits`; (5) the existing per-position body (trailing, bounce, `evaluateExit`, follow-ups) runs **only when `isOn("deterministicExit")`**, skipping positions whose trade id is in the returned set or is locked. When that body decides `close` and the trade has more than one leg → `closeTrade(trade, { reason: exit.reason, swap: true, positionsByAddr })` instead of the follow-up path. The DCA safeguard block runs only when `isOn("dca")`. After `handleMissingPositions`, call `settleTradeIfDone` for trades that contain the missing addresses.

- [ ] **Step 1: Write failing tests** (temp state/settings, fake `closeTrade` + fake PnL fetch through `deps`)
  - `adopts external position with exits off` → live position not tracked before → trade `origin === "external"`, `exit.tp.on === false`.
  - `adopts bot-tracked position as auto with preset`.
  - `tp closes after confirming re-read` → first read +16 and forced re-read +16 → `closeTrade` called with `reason: "tp"`.
  - `glitch is not acted on` → first read +16, re-read +3 → `closeTrade` not called.
  - `unknown PnL does nothing` → leg `pnlKnown` undefined → no close, `peakPnlPct` unchanged.
  - `one leg closed outside` → 2-leg trade, leg A marked `closed_not_detected` → `syncTrades` leaves the trade open; after leg B too → trade settled with `closeReason === "closed_outside"` (Review Focus 4).
  - `locked trade skipped` → `tryLockTrade` first → no evaluation, no close.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `trade-loop.js`, wire into `mainLoop`, update `execute.js`. Add to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS. Manual (`DRY_RUN=true`): with an existing on-chain position, `/start` shows 1 open trade; log shows the trade adopted as external.
- [ ] **Step 5: Checkpoint** — offer commit `feat(exit): trade-based exit loop; deterministic rules behind toggle`.

### Task 9: `/positions` UI + input parsing

**Files:**
- Create: `src/tg/parse.js`, `src/tg/positions.js`
- Modify: `src/tg/settings.js` (replace the Task 4 stub with `parseExitInput`), `src/tg/start.js` (real `openTrades` / `openPnlUsd`), `src/index.js` (register module)
- Test: `test/tg-parse.test.js`, `test/tg-positions.test.js`

**Interfaces:**
- Produces:
  - `parseExitInput(kind: "tp" | "sl" | "trail", text): object | null` — `"off"` (any case) → `{ on: false }`; tp/sl: number in (0, 1000] → `{ on: true, pct }` (a leading `+` or `-` is accepted and ignored for sl); trail: two numbers `start distance`, start ≥ 0, distance > 0 → `{ on: true, startPct, distancePct }`; otherwise `null`.
  - `parseSolAmount(text): number | null` — positive finite number, comma accepted as decimal separator.
  - `extractAddress(text): string | null` — first base58 run of 32–44 chars anywhere in the text (works for Solscan / Meteora URLs).
  - `tradeLine(trade, live)` (pure, in `positions.js`) → `"#12 BONK-SOL · spot · 0.5 SOL · +4.20% ($3.10) · in range · TP15 SL-25 T5/3"`; `live` = `{ pnlPct, pnlUsd, inRange }`, unknown PnL → `"PnL ?"`; shape null → origin label.
  - `buildPositionsList(trades, liveById) : { text, keyboard }` — one button per trade `pos:open:<id>`; empty → `"No open positions."` + `➕ Open` button.
  - `buildTradeDetail(trade, live): { text, keyboard }` — buttons `💰 Claim`(`pos:claim:<id>`) `💰 Claim+swap`(`pos:claimswap:<id>`) / `🎯 TP`(`pos:tp:<id>`) `🛑 SL`(`pos:sl:<id>`) `📈 Trail`(`pos:trail:<id>`) / `❌ Close`(`pos:close:<id>`) / `🔄 Refresh`(`pos:open:<id>`) `◀ Back`(`home:positions`).
  - Close confirm keyboard: `Close + swap to SOL` → `ok:<token{action:"close",id,swap:true}>`, `Close only` → `ok:<token{…swap:false}>`, `Cancel` → `pos:open:<id>`. The `ok:` handler lives in `bot.js` and dispatches on `payload.action` to a handler map that modules fill (`registerConfirm(action, fn)` exported from `bot.js`).
  - Live data for UI: `getOpenPositions()` → `Map` by address → `aggregateTradePnl`.
  - Text router (`bot.js`): if `session.get("prompt")` exists → dispatch to the prompt owner by `prompt.kind`; else if `extractAddress(text)` → open wizard (Task 13; until then reply "Open wizard coming soon"); else reply with the home keyboard hint.

- [ ] **Step 1: Write failing tests**
  - `tg-parse.test.js`: `parseExitInput("tp","15")` → `{on:true,pct:15}`; `("sl","-25")` → `{on:true,pct:25}`; `("trail","5 3")` → `{on:true,startPct:5,distancePct:3}`; `("trail","5")` → `null`; `("tp","OFF")` → `{on:false}`; `("tp","abc")` → `null`; `parseSolAmount("0,3")` → `0.3`; `parseSolAmount("-1")` → `null`; `extractAddress("https://solscan.io/account/<pool>?cluster=x")` → `<pool>`; `extractAddress("hello")` → `null` (Review Focus 3).
  - `tg-positions.test.js`: `tradeLine` matches the example string; `tradeLine` with unknown PnL contains `"PnL ?"`; a `pos:tp:1` callback then text `"20"` → `getTrade(1).exit.tp` deep-equals `{on:true,pct:20}`; text `"abc"` → reply contains `"Invalid"` and exit unchanged; redeeming the same close token twice calls the fake `closeTrade` once (Review Focus 1).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; claim/close call `claimTrade` / `closeTrade` and edit the message with progress (`⏳ Closing…` → result). Add modules to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS. Manual (`DRY_RUN=true`): `/positions` lists the adopted trade; set TP 20, SL off, Trail `5 3`; Close → dry-run close alert with Metlex button.
- [ ] **Step 5: Checkpoint** — offer commit `feat(tg): /positions with claim, TP/SL/Trail and close`.

---

## Stage 3 — `/open` wizard

### Task 10: Range presets and % → bins

**Files:**
- Create: `src/lp/range.js`
- Test: `test/range.test.js`

**Interfaces:**
- Produces:
  - `RANGE_PRESETS = [{ key:"narrow", label:"Narrow", below:20, above:20 }, { key:"balanced", label:"Balanced", below:45, above:45 }, { key:"wide", label:"Wide", below:65, above:65 }, { key:"narrow_sol", label:"Narrow SOL", below:20, above:0 }, { key:"balanced_sol", label:"Balanced SOL", below:45, above:0 }, { key:"wide_sol", label:"Wide SOL", below:65, above:0 }]`
  - `parseCustomRange(text): { below, above } | null` — one number → `{ below: n, above: 0 }`; two → `{ below, above }`; enforces below ∈ (0, 99], above ∈ [0, 1000].
  - `pctToBinRange({ activeBin, binStep, below, above, baseIsX }): { lowerBin, upperBin, binCount, solOnly }` — with `f = 1 + binStep/10000`: `binsBelow = floor(ln(1 − below/100) / −ln f)`, `binsAbove = floor(ln(1 + above/100) / ln f)`. `baseIsX` → `[active − binsBelow, active + binsAbove]`; SOL is X → `[active − binsAbove, active + binsBelow]`. `solOnly = above === 0`. `binCount = upper − lower + 1`.
  - `binPriceBounds({ lowerBin, upperBin, binStep, baseIsX, decimalsBase, decimalsSol }): { lowSol, highSol }` — token price in SOL at the range ends (inverted when SOL is X).

- [ ] **Step 1: Write failing tests**
  - `presets` → 6 entries with the values above.
  - `custom one number is SOL only` → `"45"` → `{below:45, above:0}`; `"45 10"` → `{below:45, above:10}`; `"100"`, `"0"`, `"45 -1"`, `"x"` → `null`.
  - `bin math base X` → binStep 100, active 1000, 45/45 → `binsBelow = floor(ln(0.55)/−ln(1.01)) = 60`, `binsAbove = floor(ln(1.45)/ln(1.01)) = 37` → `{lowerBin: 940, upperBin: 1037, binCount: 98}`.
  - `bin math SOL is X flips` → same inputs, `baseIsX: false` → `{lowerBin: 963, upperBin: 1060}`.
  - `SOL-only base X ends at active` → 45/0 → `upperBin === 1000`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Checkpoint** — offer commit `feat(lp): range presets and percent-to-bin conversion`.

### Task 11: Pool lookup

**Files:**
- Create: `src/lp/pool-lookup.js`
- Test: `test/pool-lookup.test.js`

**Interfaces:**
- Produces:
  - `resolveAddress(address, { deps } = {}): Promise<{ type: "pool", pool } | { type: "mint", pools: PoolSummary[] } | { type: "not_sol", pair } | { type: "invalid", reason }>`
    - Pool: `connection.getAccountInfo(pubkey)` owner equals the DLMM program id (`LBCLMM_PROGRAM_IDS["mainnet-beta"]` from the SDK) → check SOL pair via `getPoolInfo`; non-SOL → `not_sol`.
    - Otherwise mint: `GET https://dlmm.datapi.meteora.ag/pools?query=<mint>&page_size=50`; keep pools where one side is `WSOL_MINT` and the other is the mint; sort by TVL desc; top 5. None → `invalid` with `"not a DLMM pool or token with a SOL pool"`.
    - Account not found / not a mint and not a pool → `invalid`.
  - `PoolSummary = { address, name, binStep, baseFeePct, tvlUsd, volume24hUsd }`
  - `poolButtonLabel(s)` → `"bin 100 · 0.25% · TVL $120K · Vol $1.2M"`
  - `deps`: `{ getAccountInfo, fetchJson, getPoolInfo }`

  Note: confirm the datapi response field names (`address`, `name`, `bin_step`, `base_fee_percentage`, `tvl`, `volume.24h` or similar) with one live `curl` before writing the mapper, and pin them in the test fixture.

- [ ] **Step 1: Write failing tests** (fake deps)
  - `pool address resolves to pool`.
  - `mint resolves to top 5 SOL pools by TVL` → fixture with 7 pools incl. 1 USDC pair → 5 results, all SOL, TVL descending.
  - `wallet address is invalid` → `getAccountInfo` returns a System-owned account, datapi returns 0 pools → `type === "invalid"` (Review Focus 3).
  - `non-SOL pool` → `not_sol`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Checkpoint** — offer commit `feat(lp): resolve pasted pool or mint to SOL pools`.

### Task 12: Open-trade planning and execution

**Files:**
- Create: `src/lp/open-trade.js`
- Test: `test/open-trade.test.js`

**Interfaces:**
- Consumes: `pctToBinRange` (Task 10), `getPoolInfo`, `guardPoolPrice`, `swapSolToToken`, `swapToSol`, `getTokenBalance`, `getMintDecimals`, `buildFeePlan`, `checkFeeCap`, `sendAndConfirmRobust`, `createTrade`, `exitPresetForNewTrade`, `trackPosition`.
- Produces:
  - `SHAPES = ["spot", "curve", "bid_ask", "mixed"]`; `SOL_BUFFER = 0.08`; `MAX_TRADE_POSITIONS = 10`.
  - `planOpen({ poolAddress, depositSol, below, above, shape, deps }): Promise<Plan | { error }>` where `Plan = { poolAddress, pair, baseMint, baseIsX, activeBin, binStep, lowerBin, upperBin, binCount, positionCount, shape, depositSol, solSideSol, swapSol, rentSol, lowSol, highSol, priceGuard }`.
    - `positionCount = getPositionCountByBinCount(binCount)`; > `MAX_TRADE_POSITIONS` → `{ error: "range too wide: N positions (max 10)" }`.
    - `rentSol` = Σ `getPositionRentExemption(connection, chunkBinCount)` / 1e9 over the chunks (`chunkBinRangeIntoExtendedPositions` or equal chunks of `POSITION_MAX_LENGTH`).
    - Balance check: `balance < depositSol + SOL_BUFFER + extraRent` (extraRent = rent of positions 2..N) → `{ error: "Not enough SOL: need X, have Y (short Z)" }` (Review Focus 5).
    - SOL-only → `swapSol = 0`, `solSideSol = depositSol`.
    - Two-sided split (per strategy part; mixed = parts 0.7 BidAsk + 0.3 Spot): for 1 SOL on the SOL side, ask the SDK how much token the other side needs — base X: `x1 = autoFillXByStrategy(active, binStep, 1e9 lamports, 0, 0, lower, upper, type)`, its SOL value `v1 = x1 × activeBin.price` (lamports per raw token); SOL is X: `y1 = autoFillYByStrategy(active, binStep, 1e9, 0, 0, lower, upper, type)`, `v1 = y1 / activeBin.price`. Then `solSide = part / (1 + v1/1e9)`, `swap = part − solSide`. Sum over parts.
  - `executeOpen(plan, { onProgress, deps }): Promise<{ success, trade?, positions?, error?, dryRun? }>`
    - `config.dryRun` → return `{ success: true, dryRun: true }` after `onProgress("dry run — nothing sent")`.
    - Price guard via `guardPoolPrice` (exhausted → error).
    - Swap `plan.swapSol` (if > 0) with `swapSolToToken`; token amount = swap `amountOut`.
    - One position (`positionCount === 1`): `initializePositionAndAddLiquidityByStrategy` with the first part's amounts and strategy; `mixed` → then `addLiquidityByStrategy` with the remaining 30% amounts and `Spot`.
    - Several positions: `initializeMultiplePositionAndAddLiquidityByStrategy2` for the first part (send every tx of `instructionsByPositions` with `sendAndConfirmRobust`); `mixed` → `addLiquidityByStrategy` Spot per created position over that position's bin range.
    - Recovery: after a send error, any position keypair whose account exists on-chain counts as opened; if none exist, swap the bought token back (`swapToSol`) and return the error.
    - Success: `trackPosition(addr, pool, pair, baseMint, collectFeeMode, mode)` for each leg (mode from `classifyMode`-compatible guess: span ≥ `spotMinBins` → `"spot"`, else `"bidask:double"` / `"bidask:sol"`), then `createTrade({ …, origin: "manual", shape, range: { below, above, lowerBin, upperBin }, depositSol, exit: exitPresetForNewTrade() })`.

- [ ] **Step 1: Write failing tests** (fake deps for connection/pool/SDK helpers)
  - `SOL-only plan has no swap` → below 45 above 0 → `swapSol === 0`.
  - `two-sided plan splits by SDK autofill` → fake autofill so `v1 = 1e9` (token side worth as much as SOL side) → deposit 1 → `swapSol` ≈ 0.5 (±1e-9).
  - `mixed splits per part` → fake autofill that returns different values for BidAsk/Spot → `swapSol` = Σ of both parts' swaps.
  - `insufficient SOL refused before swap` → balance 0.5, deposit 0.5 → `{ error }` containing `"short"`, and `swapSolToToken` never called.
  - `too many positions refused` → `getPositionCountByBinCount` returns 11 → error.
  - `dry run sends nothing` → `executeOpen` with `config.dryRun` → no swap, no send, `dryRun: true`.
  - `failed open with nothing landed reverts swap` → send throws, `getAccountInfo` null → `swapToSol` called once, `success: false`.
  - `failed confirm but landed counts as success` → send throws, `getAccountInfo` non-null → trade created.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Checkpoint** — offer commit `feat(lp): plan and open SOL trades (presets, multi-position, mixed)`.

### Task 13: Open wizard UI

**Files:**
- Create: `src/tg/open-wizard.js`
- Modify: `src/tg/bot.js` text router (address → wizard), `src/index.js` (register)
- Test: `test/tg-open-wizard.test.js`

**Interfaces:**
- Consumes: Tasks 10–12, `session`, `parseSolAmount`, `extractAddress`.
- Produces:
  - Wizard state in `session.put("wizard", { step, poolAddress, pool, depositSol, below, above, shape, plan })`.
  - Steps and callback data:
    - `/open` → prompt `{ kind: "open-address" }`, text "Send a pool address or token mint".
    - Mint → buttons per pool `op:pool:<index>` (index into `wizard.candidates`).
    - Pool card (`buildPoolCard(info)` pure: pair, current price in SOL, bin step, base fee %, TVL) → deposit buttons `op:dep:0.5` `op:dep:0.7` `op:dep:0.9` `op:dep:1` `op:dep:custom` + `✖ Cancel`(`op:cancel`).
    - Range: 6 preset buttons `op:rng:<key>` + `op:rng:custom` (prompt "Send `45` for −45% SOL only, or `45 10` for −45% / +10%").
    - Shape: `op:shp:spot` `op:shp:curve` `op:shp:bid_ask` `op:shp:mixed`.
    - Confirm card (`buildConfirm(plan, exit)` pure): pair · deposit · `−45% / +45%` and `low – high SOL` · bins · positions · shape · `Swap: X SOL → token` (or `SOL only`) · `Rent (refundable): X SOL` · exit summary (or `Auto Exit off`). Buttons `✅ Confirm`(`ok:<token{action:"open"}>`) `◀ Back`(`op:back`) `✖ Cancel`(`op:cancel`).
  - `op:back` goes one step back. An expired wizard on any `op:*` → "This wizard expired — send /open again".
  - Confirm runs `executeOpen` with `onProgress` editing the message; success → `"✅ Opened #<id>"` + `Manage`(`pos:open:<id>`).

- [ ] **Step 1: Write failing tests** (fake `planOpen` / `executeOpen` / `resolveAddress`)
  - `pasting a pool goes to deposit buttons` → captured keyboard data equals `["op:dep:0.5","op:dep:0.7","op:dep:0.9","op:dep:1","op:dep:custom","op:cancel"]`.
  - `custom deposit parses` → `op:dep:custom` then text `"0,3"` → `wizard.depositSol === 0.3`.
  - `custom range "45" is SOL only` → `wizard.above === 0`.
  - `buildConfirm shows SOL only` and `shows rent and exits`.
  - `confirm token is one-shot` → two `ok:<same>` callbacks → `executeOpen` called once.
  - `expired wizard` → clear session, send `op:shp:spot` → reply contains `"expired"`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS. Manual: `DRY_RUN=true` — paste a token mint, pick a pool, `Custom` `0.3`, `Balanced`, `mixed`, check the confirm card numbers, Confirm → dry-run message. Then live (`DRY_RUN=false`) with Custom `0.1` on Balanced SOL / spot; verify the position on Meteora and in `/positions`; close it.
- [ ] **Step 5: Checkpoint** — offer commit `feat(tg): /open wizard`.

---

## Stage 4 — `/pnl`

### Task 14: PnL periods + `/pnl` UI

**Files:**
- Create: `src/lp/pnl-stats.js`, `src/tg/pnl.js`
- Modify: `src/index.js` (register)
- Test: `test/pnl-stats.test.js`, `test/tg-pnl.test.js`

**Interfaces:**
- Produces:
  - `periodStart(period: "today" | "week" | "month", now = Date.now()): number` — WIB calendar start (UTC+7): today 00:00, Monday 00:00, 1st 00:00; returned as epoch ms.
  - `summarize(closedTrades): { count, wins, winRatePct, pnlUsd, best, worst }` — trades with `closePnlUsd == null` count in `count` but not in sums; `best`/`worst` = trades by `closePnlUsd`.
  - `buildPnl(period, summary, openPnlUsd): { text, keyboard }` — tabs `pnl:today` `pnl:week` `pnl:month` (active tab marked `•`), `🧾 Recent closes`(`pnl:recent`).
  - `buildRecent(trades)` — last 10 closed: `#id pair · +x% ($y) · reason · fmtWib(closedAt)`, tx in `<code>`, one `🖼 Open Metlex` URL button.

- [ ] **Step 1: Write failing tests**
  - `today starts at WIB midnight` → `now = Date.UTC(2026, 9, 11, 2, 0)` (09:00 WIB) → `periodStart("today")` = `Date.UTC(2026, 9, 10, 17, 0)`.
  - `week starts Monday WIB` → Sunday 2026-10-11 09:00 WIB → `Date.UTC(2026, 9, 4, 17, 0)` (Mon 2026-10-05 00:00 WIB).
  - `month starts on the 1st WIB` → `Date.UTC(2026, 8, 30, 17, 0)`.
  - `just after WIB midnight belongs to the new day` → `Date.UTC(2026, 9, 10, 17, 1)` → today start `Date.UTC(2026, 9, 10, 17, 0)`.
  - `summarize` → closes `+3, −1, null` → `count 3, wins 1, pnlUsd 2, winRatePct 50` (win rate over known trades).
  - `buildRecent has Metlex url button`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS. Manual: `/pnl` tabs switch; recent closes show the dry-run/live closes.
- [ ] **Step 5: Checkpoint** — offer commit `feat(tg): /pnl today/week/month with Metlex hand-off`.

---

## Stage 5 — `/wallet`

### Task 15: Wallet key file, withdraw, `/wallet` UI

**Files:**
- Modify: `src/solana/wallet.js` — `getWallet()` reads `WALLET_KEY_FILE` first (if present and non-empty), else `config.walletPrivateKey`; add `reloadWallet()` (clears cache), `parseSecretKey(text): Keypair | null` (base58 or JSON array, 64 bytes), `saveWalletKey(keypair)` (writes base58 to `WALLET_KEY_FILE`, then `fs.chmodSync(file, 0o600)` best-effort), `exportSecretKey(): string` (base58).
- Modify: `src/index.js` startup check — accept a wallet from either source.
- Create: `src/solana/transfer.js`, `src/tg/wallet.js`
- Test: `test/wallet.test.js`, `test/tg-wallet.test.js`

**Interfaces:**
- Produces:
  - `withdrawSol({ to, amountSol, deps }): Promise<{ success, tx?, dryRun?, error? }>` — validates `to` as a `PublicKey`; `SystemProgram.transfer`; `sendAndConfirmRobust`; dry-run returns without sending.
  - `maxWithdrawSol(balanceSol) = max(0, balanceSol − 0.01)`.
  - `/wallet` card (`buildWallet({ address, sol, solUsd, tokens })`): buttons `📥 Deposit`(`wal:dep`) `📤 Withdraw`(`wal:wd`) / `🔑 Export`(`wal:exp`) `📲 Import`(`wal:imp`).
  - Withdraw: prompt address → prompt amount (`max` allowed) → confirm `ok:<token{action:"withdraw",to,amountSol}>`.
  - Export: warning + `I understand`(`ok:<token{action:"export"}>`) → send key in `<code>`; `setTimeout(() => api.deleteMessage(chatId, msgId), 60000)`.
  - Import: if `listOpenTrades().length > 0` → refuse ("Close all trades first"). Else prompt `{ kind: "wallet-import" }`; on text: `ctx.deleteMessage()` **first**, then `parseSecretKey`; invalid → "Invalid key"; valid → `saveWalletKey`, `reloadWallet`, reply with the new address.

- [ ] **Step 1: Write failing tests** (temp `WALLET_KEY_FILE`, `STATE_FILE`)
  - `key file wins over env` → write a generated key to the file → `getWallet().publicKey` equals it.
  - `reloadWallet picks up a new key`.
  - `parseSecretKey` accepts base58 and JSON array; rejects 32-byte keys and garbage.
  - `withdraw rejects bad address` → `{ success: false }` without send.
  - `maxWithdrawSol(1) === 0.99`, `maxWithdrawSol(0.005) === 0`.
  - `import deletes the user message before anything else` → captured API calls start with `deleteMessage`.
  - `import refused with open trades` → no prompt set, reply contains `"Close all trades first"`.
  - `export schedules deletion` → with fake timers (`mock.timers.enable(["setTimeout"])`), advancing 60 000 ms produces a `deleteMessage` call.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add to `MODULES`.
- [ ] **Step 4:** `npm run lint && npm test` → PASS. Manual: `/wallet` deposit shows the address; dry-run withdraw `max`; export then watch it disappear after 60 s; import a throwaway key with no open trades and check `/start` shows the new address; import back the real key.
- [ ] **Step 5: Checkpoint** — offer commit `feat(wallet): deposit, withdraw, export and import from Telegram`.

### Task 16: Docs

**Files:**
- Create: `README.md` (fresh: what it is, setup — Node, `npm install`, `.env`, BotFather token + chat id, `DRY_RUN` first; commands table; open flow with presets/shapes; Auto Exit; toggles; Metlex; wallet safety notes; runtime files; scripts)
- Modify: `.env.example` (comment: `wallet.key` overrides `WALLET_PRIVATE_KEY` after a Telegram import)
- Ask the user before touching `AGENTS.md` (they maintain it); suggest the lines that changed (toggles, trades, `settings.json`, `wallet.key`, `SETTINGS_FILE` / `WALLET_KEY_FILE` test overrides).

- [ ] **Step 1:** Write `README.md` and the `.env.example` comment.
- [ ] **Step 2:** `npm run format:check && npm run lint && npm test` → PASS.
- [ ] **Step 3: Checkpoint** — show `git status` + `git diff --stat`; offer commit `docs: fresh README for the Telegram LP assistant`.
