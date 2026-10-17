# Evil Panda exit strategy — design

Date: 2026-10-17

## Goal

Add an **Exit strategy** area to `/settings` with **Evil Panda** as the first strategy. Evil Panda keeps a
DLMM position open while price is above the 15m Supertrend, and once Supertrend support breaks it closes the
trade on the next spike (RSI(2), MACD or Bollinger Bands). If price gets back above the Supertrend before a
spike, the trade is kept and keeps earning fees.

Out of scope: the Evil Panda _entry_ (SOL-sided, -90% to -95% range in a high-fee pool). That is how the user
opens positions; this work is the exit only.

## Decisions (agreed)

| Topic         | Decision                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Signals       | RSI, MACD and BB are all built; each has its own on/off in settings. Any enabled one closes.    |
| Scope         | Per trade, like TP / SL / Trail. New trades get the default from settings; editable per trade.  |
| Timing        | Evaluated on closed 15m bars only. The forming bar is ignored.                                  |
| Bearish start | Arms only after the trade has seen a closed bar above the Supertrend and then a break below it. |

Evil Panda runs alongside TP / SL / Trail. Whichever fires first closes the trade.

## Settings (strat.conf)

New section, edited through the existing strategy editor (validation, help text, overrides in
`settings.json`):

```
# ===== Exit strategy · Evil Panda =====
EVIL_PANDA_DEFAULT_ON=false     # new trades start with Evil Panda on (only while Auto Exit is ON)
EVIL_PANDA_ST_ATR_PERIOD=10     # own Supertrend, separate from the entry one
EVIL_PANDA_ST_MULTIPLIER=3
EVIL_PANDA_RSI=true             # signal: RSI > level
EVIL_PANDA_RSI_LENGTH=2
EVIL_PANDA_RSI_LEVEL=90
EVIL_PANDA_MACD=false           # signal: first green histogram (crosses from <= 0 to > 0)
EVIL_PANDA_MACD_FAST=12
EVIL_PANDA_MACD_SLOW=26
EVIL_PANDA_MACD_SIGNAL=9
EVIL_PANDA_BB=false             # signal: close above the upper band
EVIL_PANDA_BB_LENGTH=20
EVIL_PANDA_BB_STDDEV=2
```

Validation (`strat-schema.js` OVERRIDES): periods and lengths are whole numbers >= 1 (MACD slow must be > fast
is checked at use time — invalid combo = MACD signal never fires, logged once); `RSI_LEVEL` 0–100;
multipliers and stddev > 0. All keys apply without restart (read from `config` each check).

`config.evilPanda = { defaultOn, stAtrPeriod, stMultiplier, rsi: { on, length, level }, macd: { on, fast, slow,
signal }, bb: { on, length, stdDev } }`.

## Per-trade state

- `trade.exit.panda = { on }` — set at creation from `exitPresetForNewTrade()`:
  `on = autoExit && evilPanda.defaultOn`. `exitAllOff()` (legacy / external adoption) sets it off. Old trades
  without the field are treated as off.
- `trade.panda = { seenAbove, armed, lastBar }` — progress. `lastBar` is the start time (sec) of the last
  closed bar processed. Turning Panda on/off for a trade resets progress.

## Logic

### Indicators — `src/market/indicators.js` (pure)

- `rsi(closes, length)` — Wilder smoothing (same as TradingView `ta.rsi`). Array aligned to `closes`, `null`
  before warm-up. All gains → 100, all losses → 0.
- `macd(closes, fast, slow, signal)` — EMA(fast) − EMA(slow), signal = EMA of MACD, histogram = MACD − signal.
  EMAs seeded with SMA. `null` before warm-up.
- `bollinger(closes, length, stdDev)` — SMA ± k · population stdev (TradingView `ta.stdev`). `null` before
  warm-up.
- Supertrend per bar: `computeSupertrend` today returns only the last bar. Add a sibling
  `supertrendSeries(candles, period, multiplier)` in `src/market/supertrend.js` returning
  `[{ direction, line } | null]` per candle using the same math; `computeSupertrend` keeps its behaviour.

### Evaluator — `src/exit/evil-panda.js` (pure)

`evaluatePanda(progress, closedCandles, params, { openedAtSec })` → `{ progress, fire: null | { signal, bar } }`.

For each closed bar with `time > progress.lastBar` (first run: bars with `time >= openedAtSec` bar start), in
order:

1. Supertrend direction for that bar unknown (warm-up) → skip bar.
2. **Bullish** → `seenAbove = true`, `armed = false`.
3. **Bearish** and `seenAbove` → `armed = true`.
4. **Armed**, the bar is the **latest closed bar**, and an enabled signal fires on it → `fire = { signal: "rsi" | "macd" | "bb", bar }`, stop.
   - RSI: `rsi[i] > level`.
   - MACD: `hist[i] > 0 && hist[i - 1] <= 0`.
   - BB: `close[i] > upper[i]`.
   - Check order RSI, MACD, BB (first match is reported).
5. `lastBar = bar.time` (not done for the firing bar — see Runner).

Step 2 before step 4 means a bar that closes back above the Supertrend never closes the trade (the
"don't close, keep chopping" case). Replaying all unprocessed bars rebuilds the armed state after restarts, missed ticks or turning Panda on;
a spike on an older bar never closes the trade (it would sell after the spike is gone).

### Runner — in the position monitor (`src/exit/index.js`)

Once per tick of the existing monitor loop, `kickEvilPanda(positions)` starts `runEvilPanda` in the background
(never two at once, so a slow GMGN queue does not hold the monitor loop). Incomplete candles are retried at most
every 60 s and 3 times per bar per mint. The trade is re-read after each await and skipped if Panda was turned
off or reset meanwhile.

- For each open trade with `exit.panda.on`, not locked, with at least one live leg.
- Skip unless a new 15m bar has closed since `trade.panda.lastBar` (no fetch otherwise).
- Fetch `fetchCandles(baseMint, pool, { resolution: "15m", limit: 90, allowStale: false })` — shares the GMGN
  per-mint bar cache with Auto Entry. `null` / too few candles → do nothing, retry next tick. One fetch per mint
  per tick even if several trades share it.
- Drop the forming bar (same rule as `supertrendFromClosed`); require the last closed bar to be the latest one,
  otherwise wait (data not final yet).
- Run `evaluatePanda`, save progress (`updateTradePanda`) only when it changed. Log arm / disarm at info level.
- On `fire`: re-read pool PnL (same helper TP/SL uses) for `positionsByAddr`, then
  `closeTrade(trade, { reason: \`evil_panda_${signal}\`, swap: true, positionsByAddr })`. When it fires, the
evaluator leaves `lastBar` on the bar _before_ the firing bar, so if the close fails (error, busy, a leg
  failed) the same bar fires again on the next monitor tick and the close is retried — like TP/SL retries.

Runs regardless of the Auto Exit toggle (Auto Exit only controls the default for new trades, same as TP/SL).

## Telegram

- `/settings` main screen: new button **🐼 Exit strategy** → screen listing strategies (Evil Panda, with "on for
  new trades: yes/no") → **Evil Panda** opens the strategy section view for its strat.conf section, with Back
  returning to the Exit strategy screen. Help text explains the three steps.
- `/positions` trade card: button **🐼 Panda on/off** next to TP / SL / Trail; card shows `🐼 armed` when armed.
- Close alert: `exitLabel("evil_panda_rsi")` → "Evil Panda (RSI)", likewise MACD / BB.

## Docs

README: Exit strategy section. strat.conf: section description plus help per key.

## Testing

- `indicators.test.js`: RSI / MACD / BB against hand-computed values; warm-up nulls; flat series edge cases.
- `supertrend.test.js` (or extend existing): `supertrendSeries` last element equals `computeSupertrend`.
- `evil-panda.test.js`: bearish start never arms; bullish → bearish arms; back above disarms (and that bar does
  not fire even if RSI > level); each signal fires only when enabled; replay of several bars; bars before
  `openedAt` ignored; `lastBar` advances.
- Runner test with injected deps: no fetch when no new bar; close called with `evil_panda_rsi`; locked trade
  skipped; candle fetch failure does nothing.
- Settings: `exitPresetForNewTrade` panda default; `/settings` Exit strategy screens; `/positions` Panda button.
- `strat-schema.test.js`: new keys validate.

## Safety

No transactions in tests. Manual check with `DRY_RUN=true` before live use.
