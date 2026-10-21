# Auto Entry · Bid-Ask Flip — design

Date: 2026-10-21
Source: `docs/articles/0xyunss-lp-101-an-absolute-complete-guide-for-beginner.md` (LP 101, @0xyunss)

## Goal

Replace the current Auto Entry (pool list in `pool.txt` + GMGN 15m Supertrend touch → two-sided BidAsk) with
an autonomous **bid-ask flip** strategy from the article:

1. Screen Meteora pools automatically (no `pool.txt`).
2. On a "pumped, topped, selling started" signal, deposit **single-sided SOL, BidAsk** from the current price
   down to support (DCA-in while price dumps, earning fees).
3. When most of the SOL side is crossed, **flip**: withdraw the token bins and re-deposit them **token-only,
   BidAsk, above price** (DCA-out while price bounces, earning fees again).
4. Exit when the cycle is complete, the range is broken, volume dies, or TP / SL / Trail fire.

And make the parameters **evidence-based**: an offline backtester picks starting values per profile, and every
paper / live trade is logged so a report keeps refining them.

## Decisions (agreed)

| Topic | Decision |
|---|---|
| Autonomy | Fully automatic while **Auto Entry** is ON (no confirm tap) |
| Pairs | SOL pairs only |
| Optimization | Offline backtester (Meteora 5m candles) **+** paper/live trade log and report |
| Pool universe | Two profiles, each on/off: **degen** (new pairs, short holds) and **multihour** (mature tokens) |
| Sizing / risk | Fixed SOL per profile + caps (max open, one trade per token, per-token cooldown) + daily loss brake |
| Architecture | One pure strategy engine shared by live runner, paper runner and backtester |
| Old entry | Removed: `pool.txt`, Supertrend entry signal, two-sided `bidask:double` entry and their keys |

Unchanged: `/open` wizard, manual flip, existing auto flip mechanism, TP / SL / Trail, Evil Panda, sweep,
`/positions`, `/pnl`.

## 1. Architecture

New folder `src/strategy/` — pure modules have no I/O and take everything as arguments:

| Module | Pure | Job |
|---|---|---|
| `params.js` | yes | `profileParams(config, name)` → effective params object for `degen` / `multihour` |
| `screen.js` | yes | pool filters, one-pool-per-token pick, token filters, volatility |
| `signal.js` | yes | `entrySignal(candles, p)`, `pickRangePct(candles, p, binStep)` |
| `exits.js` | yes | `evaluateStrategyExit({ trade, view, p, now })` → `{ reason, state }` |
| `limits.js` | yes | `canOpen({ profile, p, openTrades, closedTrades, mint, todayPnlSol, now })` |
| `sim.js` | yes | bin-level simulator of one trade (open → flip → exits → close) on 5m candles |
| `sources.js` | no | Meteora `/pools`, Meteora OHLCV (via `market/candles.js`), Jupiter token info, LP count |
| `runner.js` | no | live scan loop: screen → signal → limits → open (live) or paper open |
| `paper.js` | no | paper trade store + per-tick advance through `sim.js` |
| `log.js` | no | append rows to `strategy-log.jsonl` |

`src/entry/index.js` keeps its public names (`startEntryScanner`, `getWatchSnapshot`) but becomes a thin
wrapper around `strategy/runner.js`, so `src/index.js` and `src/exit/index.js` imports stay valid.

Scripts: `scripts/backtest-flip.js` (dataset fetch + optimizer), `scripts/strategy-report.js`.

## 2. Screener (replaces `pool.txt`)

Runs every `AUTO_SCAN_INTERVAL_SEC` (60) while Auto Entry is ON, once per enabled profile.

### 2.1 Pool list — Meteora datapi

`GET https://dlmm.datapi.meteora.ag/pools?page_size=100&sort_by=fee_tvl_ratio_30m:desc&filter_by=…`

Server-side filters (verified filterable): `tvl`, `volume_30m`, `fee_tvl_ratio_30m`, `bin_step`,
`is_blacklisted`. `fee_tvl_ratio_30m` is already a percent (fees_30m / tvl × 100).

Client-side filters (not filterable on the API): SOL pair (one side is WSOL), `token.market_cap`,
`token.holders`, `pool_config.base_fee_pct`, pool age from `created_at`.

### 2.2 One pool per token

Group by base mint; keep the pool with the **lowest base fee**, then **highest TVL**, then **smallest bin step**
(routers send volume to the cheapest pool — article "Selecting the Best Pools"). Skip pools whose bin step
cannot cover `RANGE_MIN_PCT` within `MAX_POSITIONS × 70` bins.

### 2.3 Enrichment (top `AUTO_CANDIDATES_PER_SCAN` per profile, default 5)

- **Jupiter token info** (`/tokens/v2/search?query=<mint,...>`, batched, cached 5 min; `api.jup.ag` with
  `JUPITER_API_KEY`, else `lite-api.jup.ag`): `organicScore ≥ AUTO_ORGANIC_SCORE_MIN` (60),
  `audit.topHoldersPercentage ≤ AUTO_TOP_HOLDERS_MAX_PCT` (30), mint and freeze authority disabled
  (`AUTO_REQUIRE_AUTHORITIES_OFF`). Missing data → candidate skipped this scan.
- **5m candles** of the pool (Meteora OHLCV, prices in SOL, volume in USD — verified), via the existing
  rate-limited `fetchCandles`. Enough bars for the signal and support lookback (≤ 90 per request).
- **Volatility** = mean of `(high − low) / open × 100` over the last 6 closed 5m bars (30m). Must be within
  `[VOLATILITY_MIN_PCT, VOLATILITY_MAX_PCT]`. This is our own measure; it may not equal Meteora's UI number.
- **LP count** (only if `MIN_LPS > 0`, final candidates only, cached 10 min): `getProgramAccounts` on the DLMM
  program with the SDK's `positionLbPairFilter(pool)`, `dataSlice` on the owner field, count distinct owners.
  RPC failure → candidate skipped this scan (fail closed).

## 3. Entry signal — "pumped, topped, selling started"

On closed 5m bars (the forming bar is ignored). With `W = PUMP_LOOKBACK_MIN / 5` bars:

- `base` = open of the first bar in the window, `high` = max high in the window, `close` = last closed close.
- `pumpPct = high / base − 1 ≥ MIN_PUMP_PCT` (20)
- `pullbackPct = 1 − close / high` within `[MIN_PULLBACK_PCT, MAX_PULLBACK_PCT]` (5 – 30)
- last closed bar is red (`close < open`).

`ENTRY_TIMING=immediate` skips the signal (enter as soon as the pool passes the screener), so the backtester
can measure whether timing helps. The existing pool-price guard (`ENTRY_POOL_PRICE_*`) runs before opening.

## 4. Range

SOL only, `shape = bid_ask`, `above = 0`, `below` from:

- `RANGE_MODE=fixed` → `RANGE_PCT`.
- `RANGE_MODE=support` → `support = min(low)` over the last `SUPPORT_LOOKBACK_MIN` (360) of 5m bars;
  `below = (1 − support / close) × 100 + SUPPORT_BUFFER_PCT` (5). Support at/above price → `RANGE_MIN_PCT`.

Then clamp to `[RANGE_MIN_PCT, RANGE_MAX_PCT]` (20 – 65) and reduce `below` until the bin count fits
`MAX_POSITIONS` (2) positions of 70 bins.

Opening reuses `planOpen` / `executeOpen` (multi-position, rent checks, price guard, revert on failure).
`executeOpen` gains optional `origin`, `exit`, `autoFlip` and `strategy` overrides (existing `/open` callers
unchanged). Pool with `nonRefundableSol > AUTO_MAX_NONREFUNDABLE_SOL` (0.02) from `planOpen` → skipped.

## 5. Lifecycle and exits

**Flip** — the trade is created with `autoFlip = { pct: FLIP_PCT }` (60). The existing `runAutoFlips` flips it
once when ≥ `FLIP_PCT`% of the SOL side has been crossed (`flipTrade`: withdraw token bins, re-deposit mirrored
width token-only BidAsk above price). Nothing new here.

**Strategy exits** — new pure evaluator, run each main-loop cycle (after `runAutoFlips`) for open trades that
have `trade.strategy`. Direction is in token-price terms (handles `xIsSol` like `crossedPct`). Timers live in
`trade.strategyState = { aboveSince, belowSince, lowVolBars, lastVolBar }`, returned by the evaluator and
written only when changed. First match wins:

| Reason | Fires when |
|---|---|
| `cycle_done` | Trade was flipped and price is above the top of every flip leg (all token sold back to SOL) |
| `pumped_away` | Not flipped, price above the SOL range top for ≥ `OOR_ABOVE_MIN` (10) — all SOL, earning nothing |
| `range_broken` | Price below the bottom of the whole range for ≥ `OOR_BELOW_MIN` (15) — cut loss |
| `volume_died` | Last `LOW_VOLUME_BARS` (3) closed 5m bars each below `MIN_VOLUME_5M_USD` |
| `max_hold` | `now − openedAt ≥ MAX_HOLD_MIN` (degen 120, multihour 1440) |

Closing uses `closeTrade(trade, { reason, swap: true })` (swap to SOL as today). The 5m volume bars come from
the `fetchVolume` call the main loop already makes per position.

**TP / SL / Trail** — auto trades get `exit` from the profile (`TP_PCT`, `SL_PCT`, `TRAIL_START_PCT`,
`TRAIL_DISTANCE_PCT`; 0 = off), not from `/settings` exit defaults, and Evil Panda off. Defaults: degen TP 10 /
SL 15, multihour TP 5 / SL 12, trail off. They run in the existing fast trade-exit loop. All exits stay
editable per trade in `/positions`.

## 6. Limits

| Rule | Default |
|---|---|
| Profile on/off | `DEGEN_ON=true`, `MULTI_ON=true` (Auto Entry toggle is the master switch) |
| Size per trade | `DEGEN_SIZE_SOL=0.5`, `MULTI_SIZE_SOL=1` |
| Max open auto trades per profile | `DEGEN_MAX_OPEN=2`, `MULTI_MAX_OPEN=2` |
| One open auto trade per token | always |
| Per-token cooldown after close | `AUTO_COOLDOWN_MIN=120`; after a loss `AUTO_COOLDOWN_LOSS_MIN=720` |
| Failed entries | existing `ENTRY_FAILURE_COOLDOWN_SEC` / `ENTRY_MAX_FAILURES` (then token blocked until restart) |
| Daily loss brake | `AUTO_DAILY_LOSS_LIMIT_SOL=0.5` |
| Gas | existing `GAS_RESERVE` + `SOL_BUFFER` (0.08) |

Cooldowns are derived from closed trades in `state.json` (last closed auto trade for the mint, loss or not), so
they survive restarts without new state. Paper trades use `paper-trades.json` the same way.

**Daily loss brake** — realized PnL of auto trades closed since 00:00 WIB, summed from `closePnlUsd` and
converted at the current SOL/USD price. At or below `−AUTO_DAILY_LOSS_LIMIT_SOL`: Auto Entry is switched OFF
(`setToggle`), one Telegram alert. Open trades keep their exits. In DRY_RUN the brake uses paper PnL.

## 7. Config (`strat.conf`)

The old sections *Auto Entry · Pools & sizing* and *Auto Entry · Signal* are replaced. Keys used by `/open`
stay (`ENTRY_POOL_PRICE_*`, `ENTRY_MAX_POOL_PRICE_DEVIATION_PCT`, Transactions section, `GAS_RESERVE`,
`ENTRY_FAILURE_COOLDOWN_SEC`, `ENTRY_MAX_FAILURES`; *Auto Entry · Safety* keeps its name).

New sections (shown automatically in `/settings → 🧩 Strategy`, 8 keys per page):

- **Auto Entry · Screener**: `AUTO_SCAN_INTERVAL_SEC`, `AUTO_CANDIDATES_PER_SCAN`, `AUTO_ORGANIC_SCORE_MIN`,
  `AUTO_TOP_HOLDERS_MAX_PCT`, `AUTO_REQUIRE_AUTHORITIES_OFF`, `AUTO_MAX_NONREFUNDABLE_SOL`.
- **Auto Entry · Degen profile** (`DEGEN_` prefix) and **Auto Entry · Multi-hour profile** (`MULTI_` prefix),
  same keys each:

| Key suffix | Degen | Multi-hour | Meaning |
|---|---|---|---|
| `ON` | true | true | profile on/off |
| `SIZE_SOL` | 0.5 | 1 | SOL per trade |
| `MAX_OPEN` | 2 | 2 | max open auto trades |
| `MIN_TVL_USD` | 2000 | 10000 | pool TVL |
| `MIN_VOLUME_30M_USD` | 10000 | 5000 | pool 30m volume |
| `MIN_FEE_TVL_30M_PCT` | 0.2 | 0.2 | fee / TVL 30m |
| `MIN_MCAP_USD` | 200000 | 3000000 | token market cap |
| `MIN_HOLDERS` | 800 | 2000 | token holders |
| `MAX_POOL_AGE_H` | 72 | 0 | 0 = any age |
| `MIN_BIN_STEP` | 80 | 20 | pool bin step |
| `MAX_BASE_FEE_PCT` | 5 | 2 | pool base fee |
| `VOLATILITY_MIN_PCT` / `VOLATILITY_MAX_PCT` | 2 / 4 | 2 / 4 | 30m volatility band |
| `MIN_LPS` | 10 | 20 | distinct LP owners, 0 = skip check |
| `ENTRY_TIMING` | pullback | pullback | `pullback` / `immediate` |
| `PUMP_LOOKBACK_MIN` | 60 | 240 | signal window |
| `MIN_PUMP_PCT` | 20 | 10 | pump size |
| `MIN_PULLBACK_PCT` / `MAX_PULLBACK_PCT` | 5 / 30 | 3 / 20 | pullback band from the high |
| `RANGE_MODE` | fixed | support | `fixed` / `support` |
| `RANGE_PCT` | 50 | 35 | fixed range below price |
| `RANGE_MIN_PCT` / `RANGE_MAX_PCT` | 20 / 65 | 15 / 50 | clamp |
| `SUPPORT_LOOKBACK_MIN` / `SUPPORT_BUFFER_PCT` | 360 / 5 | 1440 / 5 | support mode |
| `MAX_POSITIONS` | 2 | 2 | on-chain positions per trade |
| `FLIP_PCT` | 60 | 60 | auto flip threshold |
| `TP_PCT` / `SL_PCT` | 10 / 15 | 5 / 12 | 0 = off |
| `TRAIL_START_PCT` / `TRAIL_DISTANCE_PCT` | 0 / 0 | 0 / 0 | 0 = off |
| `OOR_ABOVE_MIN` / `OOR_BELOW_MIN` | 10 / 15 | 30 / 60 | out-of-range timers |
| `MIN_VOLUME_5M_USD` / `LOW_VOLUME_BARS` | 1000 / 3 | 500 / 6 | volume died |
| `MAX_HOLD_MIN` | 120 | 1440 | max hold |

  These are starting points from the article; the backtester replaces them (section 9).
  `MULTI_SUPPORT_LOOKBACK_MIN=1440` needs 288 bars → fetched in 4 requests.

- **Auto Entry · Limits**: `AUTO_COOLDOWN_MIN`, `AUTO_COOLDOWN_LOSS_MIN`, `AUTO_DAILY_LOSS_LIMIT_SOL`.
- **Auto Entry · Simulator**: `SIM_POOL_DEPTH_FACTOR=1`, `SIM_POOL_SPREAD_BINS=69`, `SIM_SWAP_COST_PCT=1`,
  `SIM_TX_COST_SOL=0.0002` (section 8).

`config.autoEntry = { scanIntervalSec, …, profiles: { degen: {…}, multihour: {…} }, limits: {…}, sim: {…} }`.
Validation in `strat-schema.js`: enums for `*_ENTRY_TIMING` and `*_RANGE_MODE`; a pattern rule for
`^(DEGEN|MULTI)_` keys (`_PCT`, `_USD`, `_MIN`, `_H` ≥ 0; `MAX_OPEN`, `MAX_POSITIONS`, `LOW_VOLUME_BARS`,
`MIN_LPS`, `MIN_HOLDERS` whole numbers; `MAX_POSITIONS` 1 – 10); `AUTO_SCAN_INTERVAL_SEC` ≥ 15 and a restart
key. All other keys apply live (read from `config` each scan).

## 8. Simulator (`src/strategy/sim.js`)

Simulates one trade on 5m candles. Units are SOL (Meteora OHLCV prices are SOL per token); USD volume is
converted with a SOL/USD 5m series (SOL-USDC DLMM pool candles, cached). PnL% is in SOL terms.

- **Bins**: `r = 1 + binStep / 10000`; bin `k` (relative to the entry bin) has price `P0 · r^k`, `P0` = open of
  the entry bar. SOL range `k ∈ [−(n−1), 0]`, `n` from `below` exactly as `pctToBinRange`.
- **Shape**: SOL per bin from the SDK's `calculateBidAskDistribution` (heavier further below price) so the
  shape matches on-chain; linear-in-distance fallback if the helper is unavailable.
- **Price path in a bar**: green bar O → L → H → C, red bar O → H → L → C (the extreme nearest the close
  happens last).
- **Conversion**: price moving down through bin `k` converts its SOL to token at `P_k`; moving up converts
  token to SOL at `P_k` (DLMM bins are constant-sum).
- **Fees**: bar volume is spread evenly over the bins the path traverses. Our fee in bin `b`:
  `v_b × baseFee × (1 − protocolFee) × our_b / (our_b + pool_b)`. Backtest: `pool_b = TVL × SIM_POOL_DEPTH_FACTOR
  / SIM_POOL_SPREAD_BINS` (TVL from the pool snapshot). Paper: `pool_b` read on-chain at entry
  (`getBinsAroundActiveBin`). The dynamic fee is ignored (conservative).
- **Flip**: when crossed bins / `n` ≥ `FLIP_PCT`, withdraw token bins below price, re-deposit token-only BidAsk
  over the same number of bins above price (mirrors `flipTrade`); costs 2 × `SIM_TX_COST_SOL`.
- **Exits**: the same `evaluateStrategyExit` and the existing pure `evaluateTradeExit` (TP / SL / Trail), checked
  at each path point; the 60s exit grace is ignored at 5m resolution.
- **Close value**: SOL in bins + token × price × (1 − `SIM_SWAP_COST_PCT`) + fees (token fees swapped the same
  way) − tx costs (open + flip + close).
- **Output**: `{ pnlPct, pnlSol, holdMin, flipped, exitReason, feesSol, path: [...] }`.

Known limits (documented in the report): 5m granularity misses intra-bar chop, our real fee share is unknown
historically (calibrated later), dynamic fees ignored, SOL/USD drift inside a trade ignored.

## 9. Backtester (`scripts/backtest-flip.js`)

```
node scripts/backtest-flip.js fetch --profile degen --days 5 --max-pools 200
node scripts/backtest-flip.js run   --profile degen --samples 400
```

- **Dataset** (`fetch`): pools from datapi sorted by `pool_created_at:desc` (degen) or filtered by TVL /
  `volume_30m` (multihour), SOL pairs only; their full 5m OHLCV for the window (≤ 90 bars per request,
  paginated, `METEORA_MAX_PER_MIN`), the SOL/USD series, and a Jupiter token snapshot. Cached in
  `data/backtest/` (gitignored), incremental. First fetch of 5 days × 200 pools ≈ 30 – 60 min.
- **Historical screen**: at each bar, the screener filters are recomputed from candles (30m volume, fee/TVL from
  volume × base fee / current TVL, volatility, market cap scaled by price ratio, pool age). Token filters
  (organic score, holders, top holders) use today's snapshot. Survivorship bias is noted in the report.
- **Replay**: per pool, walk forward; when screen + signal pass and the token is not in a trade / cooldown,
  simulate from the next bar's open. A second chronological pass applies `MAX_OPEN` and the daily brake to get
  portfolio totals.
- **Optimizer**: random search (`--samples`, default 400) over ranges for `ENTRY_TIMING`, pump/pullback,
  `RANGE_MODE` / `RANGE_PCT` / support buffer, `FLIP_PCT`, TP / SL / trail, OOR timers, `MIN_FEE_TVL_30M_PCT`
  and the volatility band. **Walk-forward**: older 70% of days = train, newest 30% = validate.
  Score = mean PnL% per trade − 0.5 × |mean of worst 10%|, requiring ≥ 20 train trades. The top 50 by train
  score are re-scored on validation; the top 10 by validation are reported.
- **Output**: console table (score, trades, win rate, mean / median PnL%, worst 10%, total SOL, max drawdown,
  avg hold, flip rate, exit-reason mix), `data/backtest/report-<profile>-<date>.md`, and
  `data/backtest/best-<profile>.conf` — a `strat.conf` snippet. **Not applied automatically**; paste it or set
  the keys from Telegram.

## 10. Paper mode

`DRY_RUN=true` and Auto Entry ON: the runner screens and signals exactly as live, but instead of a transaction it
creates a **paper trade**:

- At entry: read active bin and bin liquidity in the planned range on-chain (real `pool_b`), store pool meta,
  params and entry metrics.
- Each scan: fetch new closed 5m bars for each open paper trade and advance it through `sim.js` (same exits).
- Stored in `paper-trades.json` (path in `core/paths.js`, env-overridable like other state files, gitignored).
  Not in `state.trades`, so `/pnl` and `/positions` stay real-only.
- Telegram alerts prefixed `📝 PAPER` (entry, flip, close with reason and PnL). Limits and the daily brake apply
  to paper trades.

## 11. Trade record, learning log, report

- Auto trades: `origin: "auto"`, `trade.strategy = { profile, params, entry: { metrics, signal, rangePct } }`
  (`params` is a snapshot of the effective profile values), `trade.strategyState` (exit timers).
- On settle of an auto trade (live) or close of a paper trade, append one JSON line to `strategy-log.jsonl`
  (gitignored): `ts, mode (live|paper), profile, pool, pair, mint, params, entry metrics, pnlPct, pnlSol,
  holdMin, flipped, exitReason, predictedPnlPct`. `predictedPnlPct` = `sim.js` re-run on the trade's own
  candles with backtest pool-depth assumptions (live trades only).
- `scripts/strategy-report.js [--profile] [--since]`: per profile and per param bucket — count, win rate,
  mean / median PnL%, flip rate, exit reasons, avg hold; predicted vs actual with a suggested
  `SIM_POOL_DEPTH_FACTOR`.

## 12. Telegram

- Entry alert: `🤖 Auto entry · <profile> · <pair>` with size, range %, bin step / base fee, fee/TVL 30m,
  volatility, market cap; paper variant prefixed `📝 PAPER`.
- Close alerts: existing alert; new reason labels `cycle_done`, `pumped_away`, `range_broken`, `volume_died`,
  `max_hold`.
- Auto flip: existing alert.
- Brake: `🛑 Daily loss limit hit (−X SOL) — Auto Entry turned OFF`.
- `/settings` toggle description: "Auto Entry — screen Meteora pools and run bid-ask flip". The PM2 summary's
  watched block lists the last screener candidates (profile, pair, fee/TVL, volatility, signal state).
- README: Auto Entry sections rewritten; pool.txt text removed.

## 13. Removal

Deleted: `src/entry/pool-list.js`, `src/entry/price-watch.js`, `src/entry/candidates.js`,
`src/entry/execute.js`, `src/market/supertrend-state.js` and their tests; `BINS_BELOW` / `BINS_ABOVE` /
`STRATEGY` in `config/index.js`; config keys `POOL_LIST_FILE`, `ENTRY_DEFAULT_SIZE_SOL`,
`ENTRY_DEFAULT_MAX_POSITION`, `ENTRY_MAX_CONCURRENT_BIDASK_DOUBLE`, `ENTRY_SIZE_SPLIT`, `ENTRY_EXPIRY_HOURS`,
`ENTRY_SCAN_INTERVAL_SEC`, `ST_ATR_PERIOD`, `ST_MULTIPLIER`, `ENTRY_TOUCH_TOLERANCE_PCT`,
`SUPERTREND_CACHE_FILE`, `GMGN_MAX_STALE_MIN` (entry-only). `getPoolNames` in `pool-info.js` (reads `pool.txt`)
and `countOpenBotPositionsByPool` in `state/positions.js` removed. Entry-only Telegram notifiers that become
unused (`notifyPoolExpired`, `notifyPoolUnsupported`) removed. `deactivatePool` calls in `exit/close.js` and
`exit/index.js` are dropped (cooldowns now come from closed trades). The startup line in `src/index.js` that
prints the old entry config is replaced by a one-line summary of the enabled profiles. Leftover overrides for
removed keys in `settings.json` are ignored (existing behavior). `pool.txt` and `supertrend-cache.json` on disk
are left alone.

Kept: `pool-info.js` (`getPoolInfo`), `price-guard.js`, `runtime.js`, all `/open` and Transactions keys.
`JUPITER_POLL_INTERVAL_SEC` stays (it paces the shared Jupiter price client) and moves to the *Market data &
rate limits* section.

## 14. Errors

- datapi / Jupiter / candle fetch fails → that profile's scan is skipped, warn log (no Telegram spam).
- Entry failure → existing failure counter, cooldown and alerts (keyed by mint).
- Flip failure → existing behavior (token kept, keep-mint).
- Strategy exit close fails → logged; retried next cycle (trade lock prevents double close).
- Simulator gets incomplete candles → paper trade waits for the next scan; backtest skips the pool.

## 15. Testing

No network and never production files (env overrides for `STATE_FILE`, `SETTINGS_FILE`, new
`PAPER_FILE` / `STRATEGY_LOG_FILE`).

- `screen`: SOL-pair check, client filters, one-pool-per-token tie-breaks, bin-step coverage, volatility.
- `signal`: pump / pullback / red-bar edges, `immediate`, too few bars; range fixed / support / clamp / bin cap.
- `exits`: each reason, timer start/reset, flipped vs not, `xIsSol` orientation, first-match order.
- `limits`: max open, one per token, cooldown after win / loss, brake threshold.
- `sim`: bin conversion down/up round trip, BidAsk weights, fee share, flip mirror, close value, exits.
- Optimizer: walk-forward split, score, min-trade rule (small synthetic dataset).
- Runner / paper with stubbed sources and `executeOpen`; config parse and schema validation for new keys.
- Add new modules to `MODULES` in `test/smoke.test.js`; delete tests of removed modules.

## 16. Build phases (one plan, three phases)

1. **Engine + simulator + backtester** — `params`, `screen`, `signal`, `exits`, `limits`, `sim`, sources needed for
   fetch, `scripts/backtest-flip.js`. No change to the running bot. Output: tuned defaults per profile.
2. **Live runner + removal** — config keys and schema, `runner`, `executeOpen` overrides, strategy exits in the
   main loop, limits and brake, Telegram alerts, removal of old entry, README.
3. **Paper mode + learning loop** — `paper.js`, `strategy-log.jsonl`, predicted PnL, `scripts/strategy-report.js`.

Rollout: run paper mode (DRY_RUN) for a few days, compare with the backtest, then go live with small sizes.
