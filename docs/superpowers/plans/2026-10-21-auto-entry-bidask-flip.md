# Auto Entry · Bid-Ask Flip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pool.txt + Supertrend auto entry with an autonomous bid-ask flip strategy (Meteora screener → SOL-only BidAsk → auto flip → strategy exits), plus a backtester, paper mode and a learning log to tune it.

**Architecture:** Pure strategy modules in `src/strategy/` (params, screen, signal, exits, limits, sim, backtest) are shared by three runners: the live scan loop (`runner.js`, opens through the existing `planOpen`/`executeOpen`), paper mode (`paper.js`, simulated positions on live data) and the offline backtester (`scripts/backtest-flip.js`). Strategy exits run in the existing main loop next to `runAutoFlips`.

**Tech Stack:** Node.js 24 ESM, `node:test`, `@meteora-ag/dlmm`, Meteora datapi, Jupiter Tokens v2 / Price v3, grammy (existing).

**Spec:** `docs/superpowers/specs/2026-10-21-auto-entry-bidask-flip-design.md`

## Global Constraints

- Change as little as possible outside what a task names (AGENTS.md rule 1). No drive-by refactors.
- Tests never touch production files: set `STATE_FILE`, `SETTINGS_FILE`, `STRAT_FILE`, `PAPER_FILE`, `STRATEGY_LOG_FILE`, `BACKTEST_DIR` to a temp dir **before** importing modules (pattern: `test/toggles.test.js`). No network: stub `fetch` or inject `deps`.
- Never log, print or put private keys in test output (AGENTS.md).
- Run one test file: `node --test --import ./test/setup-env.js test/<file>.test.js`. Full suite: `npm test`. Lint: `npm run lint`.
- Code comments in the surrounding style (short, Indonesian or English as the file already uses); user-facing Telegram text in English.
- SOL pairs only (one side is `WSOL_MINT` from `src/core/constants.js`).
- Meteora datapi base `https://dlmm.datapi.meteora.ag`. Verified: `filter_by` accepts `tvl`, `volume_30m`, `fee_tvl_ratio_30m` (already a percent), `bin_step`, `is_blacklisted`, `pool_created_at` (epoch **ms**); `sort_by` accepts `fee_tvl_ratio_30m`, `volume_24h`, `tvl`, `pool_created_at`. Not filterable: `market_cap`, `holders`, `base_fee_pct`, `launchpad`.
- Meteora OHLCV: prices are **SOL per token**, volume is **USD**, max ~90 bars per request, min range 6900 s.
- Bin math must match `pctToBinRange` in `src/lp/range.js`: `binsBelow = floor(ln(1 − pct/100) / −ln(1 + binStep/10000))`, range = `binsBelow + 1` bins including the active bin.
- 70 bins per on-chain position (`DEFAULT_BIN_PER_POSITION`).
- WIB day boundaries via `periodStart("today", now)` from `src/lp/pnl-stats.js`.
- Commit after each task with the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Pool where SOL is token X (`xIsSol=true`)** — bins run the other way; range, flip and every strategy exit must act on token-price direction. Pinned in Task 4 (`exits xIsSol`) and Task 13 (`runStrategyExits xIsSol leg`).
2. **Malformed datapi rows** (`token_x`/`token_y` null, `tvl` 0 or missing, `market_cap` null) — the row is skipped, the scan continues. Pinned in Task 2 (`toPoolRow malformed`).
3. **New pool with short candle history** (fewer bars than the lookback) — no entry, no crash, volatility `null` fails the filter. Pinned in Task 2 and Task 3 (`not_enough_bars`).
4. **Restart while an auto trade is out of range** — the OOR timer continues from `trade.strategyState` instead of restarting; cooldown still applies from closed trades. Pinned in Task 13 (`timer survives restart`) and Task 5 (`cooldown from closed trades`).
5. **SOL/USD price unavailable during the brake check** — the brake must not switch Auto Entry off on a bad conversion; trades with `closePnlSol` still count, USD-only trades are skipped. Pinned in Task 5 (`todayAutoPnlSol no sol price`).

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/strategy/params.js` | create | Profile key map, defaults, `buildAutoEntry(env)`, `profileExit(p)`, `profileToConf(p)` |
| `src/strategy/screen.js` | create | datapi query URL, row parsing, pool/token/volatility filters, one pool per token |
| `src/strategy/signal.js` | create | entry signal, range %, bins math, bars needed |
| `src/strategy/exits.js` | create | `evaluateStrategyExit` |
| `src/strategy/limits.js` | create | `canOpen`, cooldowns, daily brake math |
| `src/strategy/sim.js` | create | bin-level trade simulator |
| `src/strategy/backtest.js` | create | historical screen, replay, portfolio pass, score, optimizer |
| `src/strategy/sources.js` | create | datapi / OHLCV range / Jupiter tokens / LP count / SOL-USD series I/O |
| `src/strategy/runner.js` | create | live + paper scan loop, failure tracking, snapshot |
| `src/strategy/paper.js` | create | paper trade store, open, tick |
| `src/strategy/log.js` | create | `strategy-log.jsonl` rows, predicted PnL, settled-trade logger |
| `src/exit/strategy-exit.js` | create | `runStrategyExits(positions)` for the main loop |
| `scripts/backtest-flip.js` | create | `fetch` / `run` CLI |
| `scripts/strategy-report.js` | create | log report |
| `src/config/index.js`, `src/config/strat-schema.js`, `strat.conf` | modify | new keys, validation, removed keys |
| `src/core/paths.js`, `.gitignore` | modify | `PAPER_FILE`, `STRATEGY_LOG_FILE`, `BACKTEST_DIR` |
| `src/state/trades.js` | modify | `strategy` field, `setTradeStrategyState`, `markTradeStrategyLogged` |
| `src/lp/open-trade.js` | modify | `executeOpen(plan, { meta })` |
| `src/entry/index.js` | rewrite | thin wrapper over `runner.js` |
| `src/exit/index.js`, `src/exit/close.js` | modify | strategy exits + log hook; drop `deactivatePool` |
| `src/notify/telegram.js`, `src/core/report.js`, `src/index.js` | modify | alerts, labels, summary, startup line |
| old entry modules + tests, README | delete / modify | removal |

---

# Phase 1 — Engine, simulator, backtester

### Task 1: Profile params and config keys

**Files:**
- Create: `src/strategy/params.js`
- Modify: `src/config/index.js` (add `autoEntry`), `src/config/strat-schema.js` (OVERRIDES, PATTERNS, RESTART_KEYS), `strat.conf` (new sections, appended after *Auto Entry · Safety*), `src/core/paths.js`, `.gitignore`
- Test: `test/strategy-params.test.js`, `test/strat-schema.test.js` (add cases)

**Interfaces:**
- Produces:
  - `PROFILES = ["degen", "multihour"]`, `PROFILE_PREFIX = { degen: "DEGEN", multihour: "MULTI" }`
  - `PROFILE_FIELDS: Array<{ suffix: string, field: string, type: "num"|"int"|"bool"|"enum", options?: string[] }>` in the spec §7 table order
  - `PROFILE_DEFAULTS: { degen: P, multihour: P }` (spec §7 values)
  - `buildProfile(env: object, name: string) → P` where `P = { name, on, sizeSol, maxOpen, minTvlUsd, minVolume30mUsd, minFeeTvl30mPct, minMcapUsd, minHolders, maxPoolAgeH, minBinStep, maxBaseFeePct, volatilityMinPct, volatilityMaxPct, minLps, entryTiming, pumpLookbackMin, minPumpPct, minPullbackPct, maxPullbackPct, rangeMode, rangePct, rangeMinPct, rangeMaxPct, supportLookbackMin, supportBufferPct, maxPositions, flipPct, tpPct, slPct, trailStartPct, trailDistancePct, oorAboveMin, oorBelowMin, minVolume5mUsd, lowVolumeBars, maxHoldMin }`
  - `buildAutoEntry(env) → G = { scanIntervalSec, candidatesPerScan, organicScoreMin, topHoldersMaxPct, requireAuthoritiesOff, maxNonRefundableSol, cooldownMin, cooldownLossMin, dailyLossLimitSol, sim: { poolDepthFactor, poolSpreadBins, swapCostPct, txCostSol }, profiles: { degen: P, multihour: P } }`
  - `profileExit(p) → { tp: { on, pct }, sl: { on, pct }, trail: { on, startPct, distancePct }, panda: { on: false } }`
  - `profileToConf(p) → string` (`DEGEN_SIZE_SOL=0.5\n…` in `PROFILE_FIELDS` order)
  - `config.autoEntry` (= `buildAutoEntry(e)`)
  - `paths.js`: `PAPER_FILE` (`paper-trades.json`), `STRATEGY_LOG_FILE` (`strategy-log.jsonl`), `BACKTEST_DIR` (`data/backtest`), each env-overridable via `resolveFile`

- [ ] **Step 1: Write the failing tests**

```js
test("buildProfile uses defaults when env is empty", () => {
  const d = buildProfile({}, "degen");
  assert.equal(d.sizeSol, 0.5); assert.equal(d.maxPoolAgeH, 72); assert.equal(d.entryTiming, "pullback");
  assert.equal(d.rangeMode, "fixed"); assert.equal(d.maxHoldMin, 120);
  const m = buildProfile({}, "multihour");
  assert.equal(m.minMcapUsd, 3000000); assert.equal(m.rangeMode, "support"); assert.equal(m.maxHoldMin, 1440);
});
test("buildProfile reads prefixed keys and parses types", () => {
  const p = buildProfile({ MULTI_ON: "false", MULTI_MAX_OPEN: "3", MULTI_RANGE_MODE: "fixed", MULTI_FLIP_PCT: "70" }, "multihour");
  assert.deepEqual([p.on, p.maxOpen, p.rangeMode, p.flipPct], [false, 3, "fixed", 70]);
});
test("buildProfile orders inverted min/max pairs", () => {
  const p = buildProfile({ DEGEN_VOLATILITY_MIN_PCT: "5", DEGEN_VOLATILITY_MAX_PCT: "2" }, "degen");
  assert.deepEqual([p.volatilityMinPct, p.volatilityMaxPct], [2, 5]);
});
test("invalid enum falls back to default", () => {
  assert.equal(buildProfile({ DEGEN_ENTRY_TIMING: "maybe" }, "degen").entryTiming, "pullback");
});
test("profileExit: 0 means off", () => {
  const e = profileExit({ tpPct: 10, slPct: 0, trailStartPct: 5, trailDistancePct: 0 });
  assert.deepEqual(e, { tp: { on: true, pct: 10 }, sl: { on: false, pct: 0 },
    trail: { on: false, startPct: 5, distancePct: 0 }, panda: { on: false } });
});
test("profileToConf round-trips through buildProfile", () => {
  const p = buildProfile({ DEGEN_FLIP_PCT: "45" }, "degen");
  const env = Object.fromEntries(profileToConf(p).trim().split("\n").map((l) => l.split("=")));
  assert.deepEqual(buildProfile(env, "degen"), p);
});
test("buildAutoEntry globals and sim defaults", () => {
  const g = buildAutoEntry({});
  assert.deepEqual([g.scanIntervalSec, g.candidatesPerScan, g.cooldownMin, g.cooldownLossMin, g.dailyLossLimitSol],
    [60, 5, 120, 720, 0.5]);
  assert.deepEqual(g.sim, { poolDepthFactor: 1, poolSpreadBins: 69, swapCostPct: 1, txCostSol: 0.0002 });
});
```

In `test/strat-schema.test.js` add: `typeOf("DEGEN_ENTRY_TIMING", "pullback")` is enum `["pullback","immediate"]`; `typeOf("MULTI_RANGE_MODE","support")` enum `["fixed","support"]`; `validateValue("DEGEN_MAX_POSITIONS","11",s).ok === false`; `validateValue("DEGEN_FLIP_PCT","0",s).ok === false`; `validateValue("DEGEN_RANGE_PCT","99.5",s).ok === false`; `validateValue("DEGEN_MIN_HOLDERS","1.5",s).ok === false`; `validateValue("AUTO_SCAN_INTERVAL_SEC","10",s).ok === false`; `RESTART_KEYS.has("AUTO_SCAN_INTERVAL_SEC") === true`. Use a fixture strat text containing those keys (same style as the existing fixture in that file).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import ./test/setup-env.js test/strategy-params.test.js test/strat-schema.test.js`
Expected: FAIL — `Cannot find module '../src/strategy/params.js'` and the new schema assertions fail.

- [ ] **Step 3: Implement**

- `params.js`: env key = `${PREFIX}_${suffix}`; `num` / `bool` from `src/config/env.js`; `int` = `Math.floor`; enum must be one of `options` else default; then order the pairs `rangeMinPct/rangeMaxPct`, `volatilityMinPct/volatilityMaxPct`, `minPullbackPct/maxPullbackPct`. Global keys: `AUTO_SCAN_INTERVAL_SEC=60`, `AUTO_CANDIDATES_PER_SCAN=5`, `AUTO_ORGANIC_SCORE_MIN=60`, `AUTO_TOP_HOLDERS_MAX_PCT=30`, `AUTO_REQUIRE_AUTHORITIES_OFF=true`, `AUTO_MAX_NONREFUNDABLE_SOL=0.02`, `AUTO_COOLDOWN_MIN=120`, `AUTO_COOLDOWN_LOSS_MIN=720`, `AUTO_DAILY_LOSS_LIMIT_SOL=0.5`, `SIM_POOL_DEPTH_FACTOR=1`, `SIM_POOL_SPREAD_BINS=69`, `SIM_SWAP_COST_PCT=1`, `SIM_TX_COST_SOL=0.0002`.
- `config/index.js`: `autoEntry: buildAutoEntry(e)` (nested object is updated in place by `assignDeep`, no other change).
- `strat-schema.js` OVERRIDES: `DEGEN_ENTRY_TIMING`/`MULTI_ENTRY_TIMING` enum `["pullback","immediate"]`; `DEGEN_RANGE_MODE`/`MULTI_RANGE_MODE` enum `["fixed","support"]`; `AUTO_SCAN_INTERVAL_SEC {min:15}`; `AUTO_ORGANIC_SCORE_MIN` and `AUTO_TOP_HOLDERS_MAX_PCT {min:0,max:100}`. PATTERNS, in this order (first match wins): `/^(DEGEN|MULTI)_MAX_POSITIONS$/ {min:1,max:10,int:true}`, `/^(DEGEN|MULTI)_FLIP_PCT$/ {min:1,max:100}`, `/^(DEGEN|MULTI)_RANGE_(MIN_|MAX_)?PCT$/ {gt:0,max:99}`, `/^(DEGEN|MULTI)_(MAX_OPEN|LOW_VOLUME_BARS|MIN_LPS|MIN_HOLDERS|MIN_BIN_STEP)$/ {min:0,int:true}`, `/^(DEGEN|MULTI)_.*_(PCT|USD|MIN|H|SOL)$/ {min:0}`, then the existing `_(ATTEMPTS|RETRY)$` rule. `RESTART_KEYS`: add `AUTO_SCAN_INTERVAL_SEC`.
- `strat.conf`: sections `# ===== Auto Entry · Screener =====`, `· Degen profile`, `· Multi-hour profile`, `· Limits`, `· Simulator`, each with a description comment block and a one-line help comment above every key (style of the existing file). Values = spec §7. Old keys stay until Task 15.
- `.gitignore`: add `data/`, `paper-trades.json`, `strategy-log.jsonl`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import ./test/setup-env.js test/strategy-params.test.js test/strat-schema.test.js test/config-reload.test.js`
Expected: PASS

- [ ] **Step 5: Commit** — `feat(strategy): auto entry profile params and strat.conf keys`

---

### Task 2: Screener filters

**Files:**
- Create: `src/strategy/screen.js`
- Test: `test/strategy-screen.test.js`

**Interfaces:**
- Consumes: `P`, `G` (Task 1); `WSOL_MINT`.
- Produces:
  - `poolQueryUrl(p, now, { pageSize = 100 } = {}) → string` — `…/pools?page_size=100&sort_by=fee_tvl_ratio_30m:desc&filter_by=<enc>` with `tvl>{minTvlUsd} && volume_30m>{minVolume30mUsd} && fee_tvl_ratio_30m>{minFeeTvl30mPct} && bin_step>={minBinStep} && is_blacklisted=false`, plus ` && pool_created_at>{now − maxPoolAgeH·3600000}` when `maxPoolAgeH > 0`
  - `toPoolRow(raw) → PoolRow | null`, `PoolRow = { address, name, baseMint, baseIsX, binStep, baseFeePct, protocolFeePct, tvlUsd, volume30mUsd, feeTvl30mPct, mcapUsd, holders, createdAt }` (null when not a SOL pair or any of `address`, `binStep`, `tvlUsd > 0` missing)
  - `passesPoolFilters(row, p, now) → { ok: boolean, reason: string|null }` (reasons: `tvl`, `volume`, `fee_tvl`, `mcap`, `holders`, `age`, `bin_step`, `base_fee`)
  - `pickPoolPerToken(rows) → PoolRow[]`
  - `coversMinRange(binStep, p) → boolean`
  - `passesTokenFilters(token, g) → { ok, reason }` (reasons: `no_token`, `organic`, `top_holders`, `authorities`)
  - `closedBars(candles, nowMs, barSec = 300) → candles` (drops bars with `(time + barSec)·1000 > nowMs`)
  - `volatilityPct(bars, n = 6) → number | null` (mean `(high − low)/open·100` of the last `n`; null when fewer than `n`)
  - `passesVolatility(vol, p) → boolean` (false for null)

- [ ] **Step 1: Write the failing tests**

```js
const raw = (o = {}) => ({ address: "P1", name: "AAA-SOL",
  token_x: { address: "MintA", market_cap: 500000, holders: 1000 }, token_y: { address: WSOL_MINT },
  pool_config: { bin_step: 100, base_fee_pct: 2, protocol_fee_pct: 10 }, tvl: 30000,
  volume: { "30m": 50000 }, fee_tvl_ratio: { "30m": 4.6 }, created_at: 1_000_000, ...o });
test("toPoolRow maps a SOL pair with base = X", () => {
  assert.deepEqual(toPoolRow(raw()), { address: "P1", name: "AAA-SOL", baseMint: "MintA", baseIsX: true,
    binStep: 100, baseFeePct: 2, protocolFeePct: 10, tvlUsd: 30000, volume30mUsd: 50000, feeTvl30mPct: 4.6,
    mcapUsd: 500000, holders: 1000, createdAt: 1_000_000 });
});
test("toPoolRow: SOL as X takes base from Y", () => {
  const r = toPoolRow(raw({ token_x: { address: WSOL_MINT }, token_y: { address: "MintB", market_cap: 1, holders: 2 } }));
  assert.equal(r.baseMint, "MintB"); assert.equal(r.baseIsX, false);
});
test("toPoolRow malformed rows are null", () => {
  for (const o of [{ token_x: null }, { tvl: 0 }, { tvl: undefined }, { token_y: { address: "USDC" } }, { pool_config: null }])
    assert.equal(toPoolRow(raw(o)), null, JSON.stringify(o));
  assert.equal(toPoolRow(raw({ token_x: { address: "MintA", market_cap: null, holders: null } })).mcapUsd, 0);
});
test("poolQueryUrl includes age filter only when maxPoolAgeH > 0", () => {
  const u = decodeURIComponent(poolQueryUrl({ ...buildProfile({}, "degen") }, 100 * 3600000));
  assert.match(u, /pool_created_at>28800000/);   // 100h − 72h
  assert.doesNotMatch(decodeURIComponent(poolQueryUrl(buildProfile({}, "multihour"), 0)), /pool_created_at/);
});
test("passesPoolFilters reasons", () => { /* mcap below → "mcap"; holders below → "holders"; age over → "age"; base fee over → "base_fee"; all good → ok */ });
test("pickPoolPerToken: lowest base fee, then highest TVL, then smallest bin step", () => {
  const a = { ...toPoolRow(raw()), address: "A", baseFeePct: 2, tvlUsd: 10 };
  const b = { ...a, address: "B", baseFeePct: 1, tvlUsd: 5 };
  const c = { ...a, address: "C", baseFeePct: 1, tvlUsd: 5, binStep: 80 };
  assert.deepEqual(pickPoolPerToken([a, b, c]).map((r) => r.address), ["C"]);
});
test("coversMinRange", () => {
  assert.equal(coversMinRange(100, { rangeMinPct: 20, maxPositions: 2 }), true);
  assert.equal(coversMinRange(1, { rangeMinPct: 20, maxPositions: 1 }), false);   // 2232 bins
});
test("passesTokenFilters", () => {
  const g = buildAutoEntry({}); const ok = { organicScore: 70, audit: { topHoldersPercentage: 20,
    mintAuthorityDisabled: true, freezeAuthorityDisabled: true } };
  assert.equal(passesTokenFilters(ok, g).ok, true);
  assert.equal(passesTokenFilters(null, g).reason, "no_token");
  assert.equal(passesTokenFilters({ ...ok, organicScore: 59 }, g).reason, "organic");
  assert.equal(passesTokenFilters({ ...ok, audit: { ...ok.audit, topHoldersPercentage: 31 } }, g).reason, "top_holders");
  assert.equal(passesTokenFilters({ ...ok, audit: { ...ok.audit, freezeAuthorityDisabled: false } }, g).reason, "authorities");
});
test("closedBars drops the forming bar; volatility needs 6 bars", () => {
  const bars = Array.from({ length: 7 }, (_, i) => ({ time: i * 300, open: 1, high: 1.04, low: 1.0, close: 1, volume: 1 }));
  assert.equal(closedBars(bars, 7 * 300 * 1000 - 1).length, 6);
  assert.ok(Math.abs(volatilityPct(bars.slice(0, 6)) - 4) < 1e-9);
  assert.equal(volatilityPct(bars.slice(0, 5)), null);
  assert.equal(passesVolatility(null, { volatilityMinPct: 0, volatilityMaxPct: 100 }), false);
});
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-screen.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the signatures above. `coversMinRange` uses `binsForPct` from Task 3 — to avoid an ordering problem, define `binsForPct(pct, binStep)` in `screen.js` now and re-export it from `signal.js` in Task 3.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(strategy): screener filters`

---

### Task 3: Entry signal and range

**Files:**
- Create: `src/strategy/signal.js`
- Test: `test/strategy-signal.test.js`

**Interfaces:**
- Consumes: `binsForPct` (Task 2).
- Produces:
  - `entrySignal(bars, p) → { enter: boolean, reason: string, metrics: { pumpPct, pullbackPct, high, base, close } | null }` — bars are closed 5m bars, oldest first. Reasons: `immediate`, `not_enough_bars`, `no_pump`, `pullback_small`, `pullback_large`, `not_red`, `signal`.
  - `binsForPct(pct, binStep) → int` (re-export)
  - `maxPctForBins(bins, binStep) → number` = `(1 − (1 + binStep/1e4)^−(bins − 1))·100` (largest pct whose range has `bins` bins)
  - `pickRangePct(bars, p, binStep) → number | null` (null when `rangeMinPct` cannot fit `maxPositions·70` bins)
  - `barsNeeded(p) → int` = `max(ceil(pumpLookbackMin/5) + 1, rangeMode === "support" ? ceil(supportLookbackMin/5) + 1 : 0, 7)`

- [ ] **Step 1: Write the failing tests**

```js
const bar = (o, h, l, c, t = 0) => ({ time: t, open: o, high: h, low: l, close: c, volume: 100 });
const p = { ...buildProfile({}, "degen"), pumpLookbackMin: 15 };   // W = 3 bars
test("signal fires on pump, pullback in band, red last bar", () => {
  const r = entrySignal([bar(1, 1.1, 1, 1.1), bar(1.1, 1.3, 1.1, 1.25), bar(1.25, 1.25, 1.1, 1.15)], p);
  assert.equal(r.enter, true); assert.equal(r.reason, "signal");
  assert.ok(Math.abs(r.metrics.pumpPct - 30) < 1e-9);
  assert.ok(Math.abs(r.metrics.pullbackPct - (1 - 1.15 / 1.3) * 100) < 1e-9);
});
test("signal reasons", () => {
  assert.equal(entrySignal([bar(1, 1, 1, 1)], p).reason, "not_enough_bars");
  assert.equal(entrySignal([bar(1, 1.1, 1, 1.1), bar(1.1, 1.15, 1.1, 1.12), bar(1.12, 1.12, 1.05, 1.06)], p).reason, "no_pump");
  assert.equal(entrySignal([bar(1, 1.3, 1, 1.3), bar(1.3, 1.3, 1.28, 1.3), bar(1.3, 1.3, 1.27, 1.28)], p).reason, "pullback_small");
  assert.equal(entrySignal([bar(1, 1.5, 1, 1.5), bar(1.5, 1.5, 1.0, 1.0), bar(1.0, 1.0, 0.9, 0.95)], p).reason, "pullback_large");
  assert.equal(entrySignal([bar(1, 1.3, 1, 1.3), bar(1.3, 1.3, 1.1, 1.15), bar(1.15, 1.2, 1.15, 1.18)], p).reason, "not_red");
});
test("immediate skips the signal but still needs one bar", () => {
  assert.equal(entrySignal([bar(1, 1, 1, 1)], { ...p, entryTiming: "immediate" }).enter, true);
  assert.equal(entrySignal([], { ...p, entryTiming: "immediate" }).enter, false);
});
test("pickRangePct fixed clamps to [min,max]", () => {
  const q = { ...p, rangeMode: "fixed", rangePct: 80, rangeMinPct: 20, rangeMaxPct: 65, maxPositions: 2 };
  assert.equal(pickRangePct([], q, 100), 65);
});
test("pickRangePct support = distance to lowest low + buffer", () => {
  const q = { ...p, rangeMode: "support", supportLookbackMin: 15, supportBufferPct: 5, rangeMinPct: 10, rangeMaxPct: 65, maxPositions: 2 };
  const bars = [bar(1, 1, 0.7, 0.9), bar(0.9, 1, 0.9, 1), bar(1, 1, 1, 1)];
  assert.ok(Math.abs(pickRangePct(bars, q, 100) - 35) < 1e-9);   // (1 − 0.7/1)·100 + 5
  assert.equal(pickRangePct([bar(1, 1, 1, 1)], q, 100), 10);     // support at price → min
});
test("pickRangePct shrinks to the bin cap and returns null when min does not fit", () => {
  const q = { ...p, rangeMode: "fixed", rangePct: 65, rangeMinPct: 20, rangeMaxPct: 65, maxPositions: 1 };
  const r = pickRangePct([], q, 80);                  // 65% needs 132 bins on bin step 80
  assert.ok(binsForPct(r, 80) + 1 <= 70);
  assert.equal(pickRangePct([], { ...q, rangeMinPct: 60 }, 20), null);
});
test("barsNeeded", () => {
  assert.equal(barsNeeded(buildProfile({}, "degen")), 13);
  assert.equal(barsNeeded(buildProfile({}, "multihour")), 289);
});
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-signal.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** Window = last `ceil(pumpLookbackMin/5)` bars; `base` = open of the window's first bar; `high` = max high in the window; `close` = last close; the check order is the reason order above. Support mode: lowest low over the last `ceil(supportLookbackMin/5)` bars; `support >= close` → `rangeMinPct`. Clamp to `[rangeMinPct, rangeMaxPct]`, then `min(pct, maxPctForBins(maxPositions·70, binStep))`; if the result `< rangeMinPct` → null.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(strategy): entry signal and range`

---

### Task 4: Strategy exit evaluator

**Files:**
- Create: `src/strategy/exits.js`
- Test: `test/strategy-exits.test.js`

**Interfaces:**
- Produces:
  - `STRATEGY_EXIT_REASONS = ["cycle_done", "pumped_away", "range_broken", "volume_died", "max_hold"]`
  - `tokenPos(bin, xIsSol) → number` (`xIsSol ? −bin : bin`; higher = higher token price)
  - `evaluateStrategyExit({ trade, view, p, now }) → { reason: string | null, state: { aboveSince: number | null, belowSince: number | null } }`
    - `trade`: `{ range: { lowerBin, upperBin }, flipLegs?: string[], openedAt, strategyState? }`
    - `view`: `{ activeBin, xIsSol, flipLegs: Array<{ lowerBin, upperBin }>, volumes: number[] }` (volumes = closed 5m bars, oldest first)
  - Rules (spec §5, first match wins): `cycle_done` when `trade.flipLegs?.length > 0`, `view.flipLegs` non-empty and token pos of `activeBin` > max token-pos top of every flip leg; `pumped_away` when not flipped and above the SOL range top for ≥ `oorAboveMin` min; `range_broken` when below the SOL range bottom for ≥ `oorBelowMin` min; `volume_died` when `lowVolumeBars > 0 && minVolume5mUsd > 0` and the last `lowVolumeBars` volumes all `< minVolume5mUsd`; `max_hold` when `maxHoldMin > 0 && now − openedAt ≥ maxHoldMin·60000`. `aboveSince` / `belowSince` start at the first `now` the condition holds and reset to null when it stops (`aboveSince` is always null once flipped).

- [ ] **Step 1: Write the failing tests**

```js
const P = { ...buildProfile({}, "degen"), oorAboveMin: 10, oorBelowMin: 15, lowVolumeBars: 3, minVolume5mUsd: 1000, maxHoldMin: 120 };
const T = (o = {}) => ({ range: { lowerBin: -50, upperBin: 0 }, openedAt: 0, ...o });
const V = (o = {}) => ({ activeBin: -10, xIsSol: false, flipLegs: [], volumes: [5000, 5000, 5000], ...o });
const M = 60_000;
test("in range: no reason, timers null", () => {
  assert.deepEqual(evaluateStrategyExit({ trade: T(), view: V(), p: P, now: M }), { reason: null, state: { aboveSince: null, belowSince: null } });
});
test("pumped_away after oorAboveMin", () => {
  const first = evaluateStrategyExit({ trade: T(), view: V({ activeBin: 3 }), p: P, now: 5 * M });
  assert.deepEqual(first, { reason: null, state: { aboveSince: 5 * M, belowSince: null } });
  const t = T({ strategyState: first.state });
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: 3 }), p: P, now: 15 * M }).reason, "pumped_away");
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: -1 }), p: P, now: 15 * M }).state.aboveSince, null);
});
test("range_broken after oorBelowMin", () => { /* activeBin -51, belowSince 0 → at 15·M reason range_broken; at 14·M null */ });
test("cycle_done only when flipped and above every flip leg", () => {
  const t = T({ flipLegs: ["L1"] });
  const legs = [{ lowerBin: -29, upperBin: -1 }];
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: -1, flipLegs: legs }), p: P, now: M }).reason, null);
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: 0, flipLegs: legs }), p: P, now: M }).reason, "cycle_done");
  assert.equal(evaluateStrategyExit({ trade: t, view: V({ activeBin: 3, flipLegs: legs }), p: P, now: 30 * M }).reason, "cycle_done");
});
test("flipped trade above SOL range never starts the pumped_away timer", () => {
  const r = evaluateStrategyExit({ trade: T({ flipLegs: ["L1"] }), view: V({ activeBin: 3, flipLegs: [] }), p: P, now: M });
  assert.equal(r.state.aboveSince, null);
});
test("exits xIsSol: bins run the other way", () => {
  const t = T({ range: { lowerBin: 0, upperBin: 50 } });   // token price falls as bin id rises
  const above = evaluateStrategyExit({ trade: t, view: V({ activeBin: -3, xIsSol: true }), p: P, now: M });
  assert.equal(above.state.aboveSince, M);
  const below = evaluateStrategyExit({ trade: t, view: V({ activeBin: 51, xIsSol: true }), p: P, now: M });
  assert.equal(below.state.belowSince, M);
});
test("volume_died needs lowVolumeBars low bars; disabled at 0", () => {
  assert.equal(evaluateStrategyExit({ trade: T(), view: V({ volumes: [5000, 900, 900, 900] }), p: P, now: M }).reason, "volume_died");
  assert.equal(evaluateStrategyExit({ trade: T(), view: V({ volumes: [900, 900] }), p: P, now: M }).reason, null);
  assert.equal(evaluateStrategyExit({ trade: T(), view: V({ volumes: [1, 1, 1] }), p: { ...P, lowVolumeBars: 0 }, now: M }).reason, null);
});
test("max_hold and first-match order", () => {
  assert.equal(evaluateStrategyExit({ trade: T(), view: V(), p: P, now: 120 * M }).reason, "max_hold");
  const both = evaluateStrategyExit({ trade: T({ strategyState: { aboveSince: 0, belowSince: null } }),
    view: V({ activeBin: 3, volumes: [1, 1, 1] }), p: P, now: 120 * M });
  assert.equal(both.reason, "pumped_away");
});
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-exits.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** per the rules in Interfaces. SOL range top/bottom = max/min of `tokenPos(range.lowerBin)` and `tokenPos(range.upperBin)`; flip-leg top likewise.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(strategy): strategy exit evaluator`

---

### Task 5: Limits, cooldowns, daily brake math

**Files:**
- Create: `src/strategy/limits.js`
- Test: `test/strategy-limits.test.js`

**Interfaces:**
- Consumes: `periodStart` (`src/lp/pnl-stats.js`), `G`, `P`.
- Produces:
  - `AutoTradeRef = { profile: string, baseMint: string }`, `ClosedRef = { baseMint, closedAt, closePnlUsd?: number|null, closePnlSol?: number|null }`
  - `cooldownUntil(closed: ClosedRef[], mint, g) → number` (ms; 0 when none). Latest close for the mint; loss = `closePnlSol < 0` if finite, else `closePnlUsd < 0`; `+ (loss ? cooldownLossMin : cooldownMin)·60000`.
  - `canOpen({ p, open: AutoTradeRef[], closed: ClosedRef[], mint, now, g }) → { ok, reason }` — reasons in order `profile_off`, `max_open` (open count for `p.name` ≥ `p.maxOpen`), `token_open` (any open trade with this mint, any profile), `cooldown`.
  - `todayAutoPnlSol(closed: ClosedRef[], solUsd: number | null, now) → number` — sum over closes with `closedAt ≥ periodStart("today", now)`: `closePnlSol` if finite, else `closePnlUsd / solUsd` when `solUsd > 0`, else skipped.
  - `brakeHit(pnlSol, g) → boolean` (`g.dailyLossLimitSol > 0 && pnlSol <= −g.dailyLossLimitSol`)

- [ ] **Step 1: Write the failing tests**

```js
const g = buildAutoEntry({}); const p = { ...buildProfile({}, "degen"), maxOpen: 1 };
test("canOpen order", () => {
  assert.equal(canOpen({ p: { ...p, on: false }, open: [], closed: [], mint: "M", now: 0, g }).reason, "profile_off");
  assert.equal(canOpen({ p, open: [{ profile: "degen", baseMint: "X" }], closed: [], mint: "M", now: 0, g }).reason, "max_open");
  assert.equal(canOpen({ p: { ...p, maxOpen: 2 }, open: [{ profile: "multihour", baseMint: "M" }], closed: [], mint: "M", now: 0, g }).reason, "token_open");
  assert.equal(canOpen({ p, open: [], closed: [], mint: "M", now: 0, g }).ok, true);
});
test("cooldown from closed trades: 2h after win, 12h after loss", () => {
  const win = [{ baseMint: "M", closedAt: 0, closePnlUsd: 1 }];
  const loss = [{ baseMint: "M", closedAt: 0, closePnlSol: -0.01, closePnlUsd: 5 }];
  assert.equal(cooldownUntil(win, "M", g), 120 * 60000);
  assert.equal(cooldownUntil(loss, "M", g), 720 * 60000);
  assert.equal(canOpen({ p, open: [], closed: win, mint: "M", now: 119 * 60000, g }).reason, "cooldown");
  assert.equal(canOpen({ p, open: [], closed: win, mint: "M", now: 120 * 60000, g }).ok, true);
});
test("todayAutoPnlSol mixes SOL and USD; skips USD when no SOL price", () => {
  const now = Date.UTC(2026, 9, 21, 10);   // 17:00 WIB
  const closed = [{ baseMint: "a", closedAt: now - 3600000, closePnlSol: -0.2 },
    { baseMint: "b", closedAt: now - 3600000, closePnlUsd: -30 },
    { baseMint: "c", closedAt: now - 24 * 3600000, closePnlSol: -5 }];
  assert.ok(Math.abs(todayAutoPnlSol(closed, 100, now) - -0.5) < 1e-9);
  assert.ok(Math.abs(todayAutoPnlSol(closed, null, now) - -0.2) < 1e-9);
});
test("brakeHit", () => {
  assert.equal(brakeHit(-0.5, g), true); assert.equal(brakeHit(-0.49, g), false);
  assert.equal(brakeHit(-9, { ...g, dailyLossLimitSol: 0 }), false);
});
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-limits.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(strategy): limits, cooldowns and daily brake math`

---

### Task 6: Simulator core — bins, path, conversion, fees

**Files:**
- Create: `src/strategy/sim.js`
- Test: `test/strategy-sim.test.js`

**Interfaces:**
- Consumes: `binsForPct` (Task 2).
- Produces (all pure; prices in SOL per token, bins relative to the entry bin `k = 0` at price `p0`, bin `k` price `p0·r^k`, `r = 1 + binStep/1e4`):
  - `bidAskWeights(count) → number[]` — index 0 = bin nearest the price; `w_i = (i + 1) / Σ`. (Linear BidAsk. The SDK's `calculateBidAskDistribution` is a Gaussian weight helper for another API, so it is not used; calibration absorbs the difference.)
  - `barPath(bar) → number[]` — `[open, high, low, close]` when `close < open`, else `[open, low, high, close]`
  - `binOf(price, p0, binStep) → int` = `Math.round(ln(price/p0) / ln r)`
  - `createSimPosition({ depositSol, rangePct, binStep, p0 }) → SimPos` — `n = binsForPct(rangePct, binStep) + 1` bins `k ∈ [−(n−1), 0]`, SOL by `bidAskWeights(n)` with index 0 at `k = 0`. `SimPos = { binStep, p0, n, bins: Map<k, { sol, token }>, active: 0, flip: null | { lo, hi }, feesSol: 0 }`
  - `moveActive(pos, toK) → void` — down from `a` to `b`: bins `k ∈ (b, a]` SOL → token at `P_k`; up: bins `k ∈ [a, b)` token → SOL at `P_k`; then `pos.active = toK`.
  - `accrueFees(pos, { visits: int[], volumeSol, lpFeeRate, poolLiqSolAt: (k) => number }) → number` — `volumeSol` split evenly over `visits` (bin ids, repeats allowed); per visit `share = our_k / (our_k + poolLiqSolAt(k))` with `our_k = sol_k + token_k·P_k`; adds to `pos.feesSol` and returns the amount added.
  - `pathVisits(fromK, toK) → int[]` — every bin from `fromK` to `toK` inclusive.
  - `positionValueSol(pos, price) → number` (`Σ sol + Σ token·price`, fees excluded)

- [ ] **Step 1: Write the failing tests**

```js
test("bidAskWeights grow with distance and sum to 1", () => {
  const w = bidAskWeights(4); assert.deepEqual(w.map((x) => +x.toFixed(2)), [0.1, 0.2, 0.3, 0.4]);
});
test("barPath order", () => {
  assert.deepEqual(barPath({ open: 2, high: 3, low: 1, close: 1.5 }), [2, 3, 1, 1.5]);
  assert.deepEqual(barPath({ open: 2, high: 3, low: 1, close: 2.5 }), [2, 1, 3, 2.5]);
});
test("createSimPosition matches pctToBinRange bin count", () => {
  const pos = createSimPosition({ depositSol: 1, rangePct: 50, binStep: 100, p0: 1 });
  assert.equal(pos.n, binsForPct(50, 100) + 1);
  const total = [...pos.bins.values()].reduce((s, b) => s + b.sol, 0); assert.ok(Math.abs(total - 1) < 1e-12);
  assert.ok(pos.bins.get(-(pos.n - 1)).sol > pos.bins.get(0).sol);
});
test("moveActive down converts crossed bins to token at bin price; back up restores value", () => {
  const pos = createSimPosition({ depositSol: 1, rangePct: 10, binStep: 100, p0: 1 });
  const s0 = pos.bins.get(0).sol, s1 = pos.bins.get(-1).sol;
  moveActive(pos, -2);
  assert.equal(pos.bins.get(0).sol, 0); assert.ok(Math.abs(pos.bins.get(0).token - s0) < 1e-12);
  assert.ok(Math.abs(pos.bins.get(-1).token - s1 / 1.01 ** -1) < 1e-12);
  assert.ok(pos.bins.get(-2).sol > 0);                         // new active bin not converted
  moveActive(pos, 1);
  assert.ok(Math.abs(positionValueSol(pos, 1.01) - 1) < 1e-9); // all SOL again, value preserved
});
test("accrueFees uses our share of each visited bin", () => {
  const pos = createSimPosition({ depositSol: 1, rangePct: 10, binStep: 100, p0: 1 });
  const our0 = pos.bins.get(0).sol;
  const got = accrueFees(pos, { visits: [0], volumeSol: 100, lpFeeRate: 0.01, poolLiqSolAt: () => our0 });
  assert.ok(Math.abs(got - 0.5) < 1e-12);                       // 100 · 1% · 50%
  assert.equal(accrueFees(pos, { visits: [5], volumeSol: 100, lpFeeRate: 0.01, poolLiqSolAt: () => 1 }), 0);
});
test("pathVisits", () => { assert.deepEqual(pathVisits(2, -1), [2, 1, 0, -1]); assert.deepEqual(pathVisits(0, 0), [0]); });
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-sim.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the functions above. Bins outside the position (no entry in `bins`) have `our_k = 0`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(strategy): simulator core`

---

### Task 7: Simulator trade — flip, exits, close

**Files:**
- Modify: `src/strategy/sim.js`
- Test: `test/strategy-sim.test.js` (add)

**Interfaces:**
- Consumes: Task 6; `evaluateStrategyExit` (Task 4); `evaluateTradeExit` (`src/exit/trade-exit.js`); `profileExit` (Task 1).
- Produces:
  - `flipSimPosition(pos) → { binCount, tokenAmount }` — withdraw token from bins `k > pos.active` with `token > 0` (the 70 nearest), re-deposit as token only over `k ∈ [active+1, active+binCount]` with `bidAskWeights(binCount)` (index 0 nearest); sets `pos.flip = { lo: active+1, hi: active+binCount }`.
  - `simulateTrade({ bars, entryIndex, p, pool, solUsdAt, sim, poolLiqSolAt?, stopAtSec?, rangePct? }) → SimResult | null`
    - `pool = { binStep, baseFeePct, protocolFeePct, tvlUsd }`; `solUsdAt(timeSec) → number`; `sim = G.sim`
    - default `poolLiqSolAt(k) = (pool.tvlUsd / solUsd) · sim.poolDepthFactor / sim.poolSpreadBins` (solUsd at the bar)
    - `SimResult = { pnlPct, pnlSol, feesSol, holdMin, flipped, exitReason, exitIndex, entryTime, exitTime }`
  - Algorithm: `p0 = bars[entryIndex].open`, `rangePct` = the given `rangePct` (live / paper trades pass the one they opened with), else `pickRangePct(bars.slice(0, entryIndex), p, pool.binStep)` (null → return `null`), deposit `p.sizeSol`. For each bar from `entryIndex`, walk `barPath`; for point `i` (0..3) at time `(bar.time + 75·i)` s: `moveActive` to `binOf(price)`, collect `pathVisits` for fees; after each point: flip when not flipped and `(−active)/(n−1)·100 ≥ p.flipPct`; compute `pnlPct = (positionValueSol(pos, price) + feesSol − costs − deposit) / deposit · 100` and check `evaluateTradeExit` (exit from `profileExit(p)`, peak / trail state carried) then `evaluateStrategyExit` (view built from the sim with `xIsSol: false`, `volumes` = volumes of bars before the current one). At bar end, `accrueFees` with `volumeSol = bar.volume / solUsdAt(bar.time)` and `lpFeeRate = baseFeePct/100 · (1 − protocolFeePct/100)`. Stop at the first reason, at `stopAtSec` (`exitReason: "stop"`), or at the last bar (`"end_of_data"`).
  - Close value: `Σ sol + Σ token·price·(1 − swapCostPct/100) + feesSol·(1 − swapCostPct/200) − txCostSol·txCount`, `txCount = 2·positions + (flipped ? 3 : 0)`, `positions = ceil(n/70)`.

- [ ] **Step 1: Write the failing tests**

```js
const sim = buildAutoEntry({}).sim; const pool = { binStep: 100, baseFeePct: 2, protocolFeePct: 10, tvlUsd: 100000 };
const flat = (t, px, v = 0) => ({ time: t, open: px, high: px, low: px, close: px, volume: v });
const base = { ...buildProfile({}, "degen"), rangeMode: "fixed", rangePct: 30, rangeMinPct: 10, flipPct: 60,
  tpPct: 0, slPct: 0, trailStartPct: 0, oorAboveMin: 10, oorBelowMin: 15, lowVolumeBars: 0, maxHoldMin: 0, sizeSol: 1 };
test("flipSimPosition mirrors withdrawn bins above price", () => {
  const pos = createSimPosition({ depositSol: 1, rangePct: 10, binStep: 100, p0: 1 });
  moveActive(pos, -5);
  const r = flipSimPosition(pos);
  assert.equal(r.binCount, 5); assert.deepEqual(pos.flip, { lo: -4, hi: 0 });
  assert.ok(pos.bins.get(0).token > pos.bins.get(-4).token);   // heavier further from price
});
test("flat price, no volume: loses only tx costs and ends at end_of_data", () => {
  const bars = [flat(0, 1), flat(300, 1), flat(600, 1)];
  const r = simulateTrade({ bars, entryIndex: 1, p: base, pool, solUsdAt: () => 100, sim });
  assert.equal(r.exitReason, "end_of_data"); assert.equal(r.flipped, false);
  assert.ok(Math.abs(r.pnlSol - -(2 * sim.txCostSol)) < 1e-9);
});
test("dump through 60% flips, bounce above flip leg ends with cycle_done", () => {
  const bars = [flat(0, 1), flat(300, 1), flat(600, 0.75), flat(900, 1.1)];
  const r = simulateTrade({ bars, entryIndex: 1, p: base, pool, solUsdAt: () => 100, sim });
  assert.equal(r.flipped, true); assert.equal(r.exitReason, "cycle_done");
});
test("dump below range for oorBelowMin ends with range_broken and a loss", () => {
  const bars = [flat(0, 1), flat(300, 1), ...Array.from({ length: 5 }, (_, i) => flat(600 + 300 * i, 0.5))];
  const r = simulateTrade({ bars, entryIndex: 1, p: base, pool, solUsdAt: () => 100, sim });
  assert.equal(r.exitReason, "range_broken"); assert.ok(r.pnlPct < -20);
});
test("volume in range earns fees", () => {
  const bars = [flat(0, 1), { time: 300, open: 1, high: 1, low: 0.97, close: 0.99, volume: 1e6 }, flat(600, 1)];
  const r = simulateTrade({ bars, entryIndex: 1, p: base, pool, solUsdAt: () => 100, sim });
  assert.ok(r.feesSol > 0);
});
test("TP from profile exit fires", () => { /* bars dumping then volume-heavy chop with tpPct: 0.5 → exitReason "tp" */ });
test("stopAtSec closes with reason stop", () => {
  const bars = [flat(0, 1), flat(300, 1), flat(600, 1), flat(900, 1)];
  assert.equal(simulateTrade({ bars, entryIndex: 1, p: base, pool, solUsdAt: () => 100, sim, stopAtSec: 600 }).exitReason, "stop");
});
test("explicit rangePct overrides pickRangePct", () => {
  // −25%: bin −29. A 60% range (92 bins below) is 31% crossed → no flip; a 20% range (22 bins below) is past 60% → flip.
  const bars = [flat(0, 1), flat(300, 1), flat(600, 0.75)];
  const q = { ...base, rangePct: 60 };
  assert.equal(simulateTrade({ bars, entryIndex: 1, p: q, pool, solUsdAt: () => 100, sim }).flipped, false);
  assert.equal(simulateTrade({ bars, entryIndex: 1, p: q, pool, solUsdAt: () => 100, sim, rangePct: 20 }).flipped, true);
});
test("no range when rangeMin cannot fit → null", () => {
  assert.equal(simulateTrade({ bars: [flat(0, 1), flat(300, 1)], entryIndex: 1,
    p: { ...base, rangeMinPct: 60, rangePct: 60, maxPositions: 1 }, pool: { ...pool, binStep: 20 }, solUsdAt: () => 100, sim }), null);
});
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-sim.test.js` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** `flipSimPosition` and `simulateTrade` per Interfaces.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(strategy): simulate a full bid-ask flip trade`

---

### Task 8: Data sources and backtest `fetch`

**Files:**
- Create: `src/strategy/sources.js`, `scripts/backtest-flip.js` (`fetch` command only)
- Test: `test/strategy-sources.test.js`

**Interfaces:**
- Consumes: `toPoolRow` (Task 2), `BACKTEST_DIR` (Task 1), `config.jupiterSwapApiKey`/`jupiterPriceApiKey`, `config.meteoraMaxPerMin`, `WSOL_MINT`, `USDC_MINT`.
- Produces (each takes `deps = { fetchJson, sleep, now, connection }` for tests; defaults are real):
  - `fetchJson(url, { headers } = {}) → any` (8 s timeout, throws on non-2xx)
  - `fetchPoolRows(url, { deps }) → PoolRow[]` (raw `data` mapped with `toPoolRow`, nulls dropped)
  - `fetchOhlcvRange(pool, startSec, endSec, { deps }) → Bar[]` — 5m bars `{ time, open, high, low, close, volume }`, windows of `90·300` s (each at least 6900 s), paced `60000 / meteoraMaxPerMin` ms apart, deduped and sorted.
  - `fetchTokens(mints, { deps }) → Map<mint, token>` — batches of 100 to `https://api.jup.ag/tokens/v2/search?query=a,b` with `x-api-key` when a Jupiter key is set, else `https://lite-api.jup.ag/tokens/v2/search?query=…`; keyed by `id`; 5-minute in-memory cache.
  - `findSolUsdPool({ deps }) → string` — first row of `/pools?page_size=20&sort_by=volume_24h:desc` whose tokens are WSOL and USDC.
  - `solUsdSeries(bars, solIsX) → Array<[timeSec, usd]>` (close, inverted when SOL is Y) and `solUsdAtFn(series) → (timeSec) => usd` (last point at or before `timeSec`, else the first).
  - CLI `node scripts/backtest-flip.js fetch --profile <degen|multihour> --days <5> --max-pools <200>`:
    - degen universe: `/pools?page_size=100&sort_by=volume_24h:desc&filter_by=pool_created_at>{now−days·86400000} && is_blacklisted=false`
    - multihour universe: `…&filter_by=tvl>{minTvlUsd} && is_blacklisted=false`
    - keep SOL pairs until `--max-pools`; writes `BACKTEST_DIR/<profile>/dataset.json` = `{ fetchedAt, days, pools: [{ row, token }], solUsd: [[t, usd], …] }` and `BACKTEST_DIR/<profile>/bars/<pool>.json`; skips pools whose bars file already covers the window (incremental); prints progress `pool i/N`.

- [ ] **Step 1: Write the failing tests** (stub `deps.fetchJson` by URL; never real network)

```js
test("fetchOhlcvRange paginates windows and dedupes", async () => {
  const calls = [];
  const deps = { sleep: async () => {}, fetchJson: async (url) => { calls.push(url);
    const s = Number(new URL(url).searchParams.get("start_time"));
    return { data: [{ timestamp: s, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { timestamp: s + 300, open: 1, high: 1, low: 1, close: 1, volume: 1 }] }; } };
  const bars = await fetchOhlcvRange("P", 0, 60000, { deps });
  assert.equal(calls.length, 3);                                   // 60000 / 27000
  assert.deepEqual(bars.map((b) => b.time), [...new Set(bars.map((b) => b.time))].sort((a, b) => a - b));
});
test("fetchTokens batches by 100 and keys by id", async () => { /* 150 mints → 2 calls; Map size equals returned rows */ });
test("findSolUsdPool picks the WSOL/USDC row", async () => { /* first row is X-USDC, second WSOL/USDC → second address */ });
test("solUsdAtFn picks last point at or before time", () => {
  const at = solUsdAtFn([[0, 100], [300, 110]]);
  assert.equal(at(299), 100); assert.equal(at(300), 110); assert.equal(at(-5), 100);
});
test("solUsdSeries inverts when SOL is Y", () => {
  assert.deepEqual(solUsdSeries([{ time: 0, close: 0.01 }], false), [[0, 100]]);
});
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-sources.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `sources.js` and the `fetch` command (argument parsing with `process.argv`, no new dependency).
- [ ] **Step 4: Run** the test — Expected: PASS. Then a live smoke check (read-only public APIs, small): `node scripts/backtest-flip.js fetch --profile degen --days 1 --max-pools 3` — Expected: prints 3 pools, `data/backtest/degen/dataset.json` exists, each bars file has > 0 bars.
- [ ] **Step 5: Commit** — `feat(backtest): data sources and dataset fetch`

---

### Task 9: Backtest replay and portfolio pass

**Files:**
- Create: `src/strategy/backtest.js`
- Test: `test/strategy-backtest.test.js`

**Interfaces:**
- Consumes: Tasks 2, 3, 5, 7.
- Produces:
  - `historicalScreen(row, bars, i, p) → { ok, metrics: { volume30mUsd, feeTvl30mPct, volatilityPct, mcapUsd, poolAgeH } }` — `volume30mUsd` = sum of `bars[i−5..i].volume`; `feeTvl30mPct = volume30mUsd · baseFeePct/100 / row.tvlUsd · 100`; `mcapUsd = row.mcapUsd · bars[i].close / bars.at(−1).close`; `now = (bars[i].time + 300)·1000`; ok = `passesPoolFilters({ ...row, volume30mUsd, feeTvl30mPct, mcapUsd }, p, now).ok && passesVolatility(volatilityPct(bars.slice(0, i + 1)), p)`
  - `replayPool({ row, token, bars, p, g, solUsdAt }) → SimTrade[]` — returns `[]` when `!passesTokenFilters(token, g).ok` or `!coversMinRange`; walks `i` from `barsNeeded(p) − 1`; at each `i` passing `historicalScreen` and `entrySignal(bars.slice(0, i + 1), p).enter`, runs `simulateTrade({ entryIndex: i + 1, … })`; next search starts after the exit bar + cooldown bars (`cooldownMin` or `cooldownLossMin` by result, ÷ 5). `SimTrade = { pool, mint, profile, …SimResult, entryMetrics }`.
  - `portfolioPass(trades, p, g) → { accepted: SimTrade[], totals }` — chronological by `entryTime`; skip when `p.maxOpen` trades are open at that time, or when that WIB day's accepted PnL already hit `brakeHit`. `totals = { trades, winRate, meanPct, medianPct, worst10Pct, totalSol, maxDrawdownSol, avgHoldMin, flipRate, exitMix: { [reason]: count } }`.

- [ ] **Step 1: Write the failing tests** — synthetic bars only.

```js
test("historicalScreen computes 30m volume and fee/TVL from bars", () => {
  const row = { ...rowFixture, tvlUsd: 10000, baseFeePct: 2, mcapUsd: 1e6, createdAt: 0 };
  const bars = Array.from({ length: 6 }, (_, i) => ({ time: i * 300, open: 1, high: 1.03, low: 1, close: 1, volume: 1000 }));
  const r = historicalScreen(row, bars, 5, loosenedProfile);
  assert.equal(r.metrics.volume30mUsd, 6000); assert.ok(Math.abs(r.metrics.feeTvl30mPct - 1.2) < 1e-9);
});
test("replayPool returns [] when token filters fail", () => { /* token organicScore 10 */ });
test("replayPool does not overlap trades and respects cooldown", () => {
  // pump/dump pattern repeated twice; with cooldownMin huge only one trade; with 0 two trades, second entryTime > first exitTime
});
test("portfolioPass enforces maxOpen and the daily brake", () => {
  const t = (entry, exit, pnlSol) => ({ entryTime: entry, exitTime: exit, pnlSol, pnlPct: pnlSol * 100, holdMin: 5, flipped: false, exitReason: "sl" });
  const { accepted } = portfolioPass([t(0, 100, -0.3), t(10, 50, -0.3), t(200, 300, -0.3), t(400, 500, 1)],
    { ...profile, maxOpen: 1 }, { ...g, dailyLossLimitSol: 0.5 });
  assert.equal(accepted.length, 2);   // 2nd overlaps, 4th after brake (−0.6)
});
test("totals", () => { /* winRate, medianPct, worst10Pct on a known list of 10 trades */ });
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-backtest.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(backtest): replay pools and portfolio totals`

---

### Task 10: Optimizer and backtest `run`

**Files:**
- Modify: `src/strategy/backtest.js`, `scripts/backtest-flip.js` (add `run`)
- Test: `test/strategy-backtest.test.js` (add)

**Interfaces:**
- Consumes: Task 9, `profileToConf` (Task 1).
- Produces:
  - `SEARCH_SPACE = { common: {...}, degen: { maxHoldMin: [60, 120, 240] }, multihour: { maxHoldMin: [360, 720, 1440, 2880] } }` with `common`: `entryTiming ["pullback","immediate"]`, `minPumpPct [10,15,20,30,50]`, `minPullbackPct [3,5,8,12]`, `maxPullbackPct [20,30,40]`, `rangeMode ["fixed","support"]`, `rangePct [25,35,45,55,65]`, `supportBufferPct [0,5,10]`, `flipPct [40,50,60,70,80]`, `tpPct [0,3,5,8,10,15,20]`, `slPct [0,10,15,20,30]`, `trail [[0,0],[5,2],[5,3],[10,3]]` (→ `trailStartPct`, `trailDistancePct`), `oorAboveMin [5,10,20,30,60]`, `oorBelowMin [5,15,30,60,120]`, `minFeeTvl30mPct [0.1,0.2,0.5,1]`, `volatility [[1,4],[2,4],[2,6],[3,8],[0,100]]` (→ min/max)
  - `mulberry32(seed) → () => number` (seeded RNG)
  - `sampleParams(space, rng) → Partial<P>`
  - `scoreTrades(trades, { minTrades = 20 } = {}) → number` = `meanPct − 0.5·|worst10Pct|`, `−Infinity` below `minTrades`
  - `optimize({ dataset, barsByPool, baseP, g, solUsdAt, samples, seed, trainFrac = 0.7 }) → { cutoffSec, results: Array<{ params, train, validate }> }` — cutoff = first bar time + `trainFrac` of the dataset time span; per sample replay all pools once, split trades by `entryTime < cutoff`, `portfolioPass` each side; keep the top 50 by train score, sort those by validation score, return the top 10.
  - CLI `node scripts/backtest-flip.js run --profile <name> --samples <400> --seed <1>` — base params from current `config.autoEntry.profiles[profile]`; prints a table (rank, train score/trades, validate score/trades, win rate, mean / median %, worst 10 %, total SOL, max drawdown, avg hold, flip rate, top exit reasons, changed params); writes `BACKTEST_DIR/<profile>/report-<YYYY-MM-DD>.md` (table + the limits list from spec §8) and `BACKTEST_DIR/<profile>/best.conf` (= `profileToConf` of rank 1). Prints `Not applied — paste best.conf into strat.conf or set the keys in /settings → 🧩 Strategy.`

- [ ] **Step 1: Write the failing tests**

```js
test("mulberry32 is deterministic", () => { const a = mulberry32(1), b = mulberry32(1); assert.equal(a(), b()); });
test("sampleParams draws only from the space and expands pairs", () => {
  const s = sampleParams({ ...SEARCH_SPACE.common, ...SEARCH_SPACE.degen }, mulberry32(7));
  assert.ok(SEARCH_SPACE.common.flipPct.includes(s.flipPct));
  assert.ok("trailStartPct" in s && "volatilityMinPct" in s && !("trail" in s));
});
test("scoreTrades", () => {
  const t = (pct) => ({ pnlPct: pct });
  assert.equal(scoreTrades([t(1)], { minTrades: 2 }), -Infinity);
  const list = [...Array(9).fill(t(2)), t(-10)];
  assert.ok(Math.abs(scoreTrades(list, { minTrades: 10 }) - (0.8 - 5)) < 1e-9);
});
test("optimize splits by time and ranks by validation", async () => { /* tiny synthetic dataset, samples 5, assert results.length ≤ 10, each has train.trades + validate.trades, results sorted by validate score desc */ });
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-backtest.test.js` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the tests — Expected: PASS. Then on the Task 8 smoke dataset: `node scripts/backtest-flip.js run --profile degen --samples 20` — Expected: prints a table (possibly "no parameter set reached 20 trades" on a 3-pool dataset — that message must exist), writes `report-*.md`.
- [ ] **Step 5: Commit** — `feat(backtest): random-search optimizer with walk-forward validation`

---

# Phase 2 — Live runner and removal

### Task 11: Trade strategy fields and `executeOpen` meta

**Files:**
- Modify: `src/state/trades.js`, `src/lp/open-trade.js`
- Test: `test/trades.test.js`, `test/open-trade.test.js` (add cases)

**Interfaces:**
- Produces:
  - `createTrade({ …, strategy = null })` — sets `trade.strategy` when given
  - `updateTradeMeta(id, { origin, exit, depositSol, strategy })` — `strategy` set when not undefined
  - `setTradeStrategyState(id, state) → trade | null` (writes `trade.strategyState`; no-op on closed trades)
  - `markTradeStrategyLogged(id) → trade | null` (sets `trade.strategyLogged = true`)
  - `executeOpen(plan, { onProgress, deps, meta } = {})`, `meta = { origin?: string, exit?: object, autoFlip?: object | null, strategy?: object }` — defaults keep today's behavior (`"manual"`, `exitPresetForNewTrade()`, `autoFlipForNewTrade(shape)`); the adoption fix-up (`trade.origin !== origin` → `updateTradeMeta`) uses the meta values and also passes `strategy`.
  - `trade.strategy` shape (written by Task 12): `{ profile, params: P, entry: { metrics, signal, rangePct, poolMeta: { binStep, baseFeePct, protocolFeePct, tvlUsd } } }`

- [ ] **Step 1: Write the failing tests** — in `trades.test.js`: `createTrade({ …, strategy: { profile: "degen" } }).strategy.profile === "degen"`; trade without strategy has no `strategy` key; `setTradeStrategyState` persists and ignores closed trades; `markTradeStrategyLogged`. In `open-trade.test.js` (use the existing stubbed-deps live-open test as template): `executeOpen(plan, { deps, meta: { origin: "auto", exit: E, autoFlip: { pct: 70 }, strategy: S } })` → created trade has `origin "auto"`, `exit` deep-equals `E`, `autoFlip.pct === 70`, `strategy` deep-equals `S`; without `meta` the existing assertions still hold.
- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/trades.test.js test/open-trade.test.js` — Expected: new cases FAIL.
- [ ] **Step 3: Implement** the interface changes only.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(open): auto-entry metadata on executeOpen and trades`

---

### Task 12: Live runner, LP count, entry alert, summary

**Files:**
- Create: `src/strategy/runner.js`
- Modify: `src/strategy/sources.js` (`countPoolLps`), `src/entry/index.js` (rewrite), `src/notify/telegram.js` (`notifyAutoEntry`), `src/core/report.js` (`watchLine`), `src/tg/settings.js` (one help line)
- Test: `test/strategy-runner.test.js`, `test/toggles.test.js` (rewrite), `test/report.test.js` (update the watched case), `test/strategy-sources.test.js` (add), `test/tg-settings.test.js` (add)

**Interfaces:**
- Consumes: Tasks 1–5, 11; `planOpen`, `executeOpen`; `fetchCandles` (`src/market/candles.js`, `resolution: "5m"`); `listOpenTrades`, `listClosedTrades`; `isOn`; `getPrice(WSOL_MINT)`; runtime `addEntryInProgressMint`/`removeEntryInProgressMint`.
- Produces:
  - `countPoolLps(pool, { deps }) → number | null` — `getProgramAccounts(LBCLMM_PROGRAM_IDS["mainnet-beta"], { filters: [positionV2Filter(), positionLbPairFilter(pool)], dataSlice: { offset: 40, length: 32 } })`, distinct owners; null on error; cached 10 min per pool. (Owner offset 40 = 8-byte discriminator + 32-byte `lb_pair`; confirm against `positionOwnerFilter` in the SDK build.)
  - `scanProfile(name, { deps }) → { candidates: Snapshot[], opened: string[] }`
  - `runScan({ deps } = {}) → void` — returns at once when `isOn("autoEntry")` is false or a scan is running; runs the brake check (Task 14 adds it) then each profile with `p.on`.
  - `getScreenSnapshot() → Snapshot[]`, `Snapshot = { profile, pairName, pool, feeTvl30mPct, volatilityPct, signal }` (`signal` = `entrySignal` reason or a filter reason)
  - `startRunner() → { timer }` (interval `config.autoEntry.scanIntervalSec`, first scan right away)
  - `entry/index.js`: `startEntryScanner = startRunner`, `getWatchSnapshot = getScreenSnapshot`; `deactivatePool` exported as a no-op until Task 15 removes its callers.
  - `notifyAutoEntry({ profile, pair, pool, sizeSol, rangePct, binStep, baseFeePct, feeTvl30mPct, volatilityPct, mcapUsd, paper = false })` — text:
    ```
    {📝 PAPER }🤖 Auto entry · {profile} · {pair}
    Size {sizeSol} SOL · range −{rangePct.toFixed(0)}% · bin {binStep} · fee {baseFeePct}%
    Fee/TVL 30m {feeTvl30mPct.toFixed(2)}% · volatility {volatilityPct.toFixed(1)}% · MC {fmtUsd(mcapUsd)}
    Pool: {pool}
    ```
  - `report.js` `watchLine(w)`: `{pairName or pool…} | {profile} | fee/TVL {x.xx}% | vol {x.x}% | {signal}`
  - `tg/settings.js` help text gains the line `Auto Entry screens Meteora pools and runs the bid-ask flip (profiles in 🧩 Strategy).`
- Scan flow per profile (`deps` injectable: `fetchPoolRows`, `fetchTokens`, `fetchCandles`, `countPoolLps`, `planOpen`, `executeOpen`, `openPaperTrade`, `listOpenTrades`, `listClosedTrades`, `notify`, `now`, `dryRun`):
  1. rows = `fetchPoolRows(poolQueryUrl(p, now))` → `passesPoolFilters` + `coversMinRange` → `pickPoolPerToken`.
  2. Drop tokens failing `canOpen` (open/closed refs built from trades with `origin === "auto" && strategy`, mapped `{ profile: strategy.profile, baseMint }`; in DRY_RUN from paper trades) or blocked by failures; keep the first `g.candidatesPerScan`.
  3. `fetchTokens` → `passesTokenFilters`.
  4. Per candidate: `bars = closedBars(fetchCandles(mint, pool, { resolution: "5m", limit: barsNeeded(p) + 1 }), now)`; `passesVolatility`; `entrySignal`; `p.minLps > 0` → `countPoolLps < minLps` skips (null skips); `pickRangePct` (null skips).
  5. Re-check `canOpen` (counting this scan's opens). DRY_RUN → `openPaperTrade(...)` (Task 16; until then log `[DRY RUN] would open …`). Live → skip (no failure count, warn once per scan) when `await deps.getSolBalance() < p.sizeSol + config.entry.gasReserve + SOL_BUFFER`; then `planOpen({ poolAddress, depositSol: p.sizeSol, below: rangePct, above: 0, shape: "bid_ask" })`; skip when `plan.error`, `plan.nonRefundableSol > g.maxNonRefundableSol` or `plan.positionCount > p.maxPositions`; `executeOpen(plan, { meta: { origin: "auto", exit: profileExit(p), autoFlip: { pct: p.flipPct }, strategy } })`.
  6. Success → `notifyAutoEntry`, `recordAction`. Failure → per-mint failure count; cooldown `ENTRY_FAILURE_COOLDOWN_SEC`; at `ENTRY_MAX_FAILURES` the mint is blocked until restart; alerts via existing `notifyEntryFailed` / `notifyEntryAborted` with the pool and pair.
  - API error in steps 1–3 → warn log, that profile skipped this scan.

- [ ] **Step 1: Write the failing tests** (`strategy-runner.test.js`, temp state/settings, all deps stubbed)

```js
test("runScan does nothing when Auto Entry is off", async () => { /* setToggle off; deps.fetchPoolRows spy never called */ });
test("happy path opens one live trade with auto meta", async () => {
  // one row passing filters, token passing, bars forming a signal; planOpen stub returns { positionCount: 1, nonRefundableSol: 0 }
  // assert executeOpen called once with meta.origin "auto", meta.autoFlip.pct === p.flipPct, meta.strategy.profile "degen",
  // plan args { below: rangePct, above: 0, shape: "bid_ask", depositSol: p.sizeSol }; notify called with profile "degen"
});
test("skips non-refundable rent above the cap and too many positions", async () => { /* executeOpen not called */ });
test("skips when wallet SOL is below size + GAS_RESERVE + 0.08, without counting a failure", async () => {});
test("token already open in another profile is skipped", async () => { /* listOpenTrades returns auto trade with same mint */ });
test("datapi failure skips the profile without throwing", async () => { /* fetchPoolRows rejects → runScan resolves */ });
test("failures: cooldown then block after ENTRY_MAX_FAILURES", async () => { /* executeOpen returns { success:false } 3× with now advanced past cooldown → 4th scan does not call executeOpen */ });
test("snapshot lists candidates with signal reason", async () => { /* getScreenSnapshot()[0].signal === "not_red" */ });
test("DRY_RUN never calls planOpen/executeOpen", async () => { /* deps.dryRun true */ });
```

`toggles.test.js`: replace the old entry tests with "runScan returns without fetching when autoEntry off; fetches the datapi pool list when on" using a `fetch` spy (same `withFetchSpy` helper; assert a URL starting with `https://dlmm.datapi.meteora.ag/pools?`). `report.test.js`: watched fixture `{ profile: "degen", pairName: "AAA-SOL", pool: "P", feeTvl30mPct: 0.85, volatilityPct: 3.1, signal: "signal" }` → line contains `degen | fee/TVL 0.85% | vol 3.1% | signal`. `tg-settings.test.js`: settings text contains `Auto Entry screens Meteora pools`. `strategy-sources.test.js`: `countPoolLps` with a stub connection returning 3 accounts from 2 owners → 2; error → null.

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-runner.test.js test/toggles.test.js test/report.test.js test/strategy-sources.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the same — Expected: PASS. Then `npm test` — Expected: PASS (old entry tests still pass or were rewritten here; the remaining ones are deleted in Task 15).
- [ ] **Step 5: Commit** — `feat(strategy): live screener runner replaces pool.txt scan`

---

### Task 13: Strategy exits in the main loop

**Files:**
- Create: `src/exit/strategy-exit.js`
- Modify: `src/exit/index.js` (call after `runAutoFlips`), `src/notify/telegram.js` (`exitLabel`)
- Test: `test/strategy-exit-loop.test.js`, `test/telegram.test.js` (labels)

**Interfaces:**
- Consumes: `evaluateStrategyExit` (Task 4), `closedBars` (Task 2), `setTradeStrategyState` (Task 11), `closeTrade`, `listOpenTrades`, `tradeLock`, `getTrackedPosition`, `fetchCandles`.
- Produces:
  - `runStrategyExits(positions, { deps = {}, now = Date.now() } = {}) → Promise<number[]>` (ids closed) — for each open trade with `trade.strategy` and no lock: live legs = `positions` by address, skipping legs closed in state; no live leg → skip; `view = { activeBin, xIsSol }` from the first live non-flip leg (else first live leg); `flipLegs` = live legs listed in `trade.flipLegs` → `{ lowerBin, upperBin }`; `volumes` only when `params.lowVolumeBars > 0` (`fetchCandles(baseMint, pool, { resolution: "5m", limit: lowVolumeBars + 2 })` → `closedBars` → volume). `p = trade.strategy.params`. Persist state only when it differs from `trade.strategyState`. On a reason → `closeTrade(trade, { reason, swap: true, positionsByAddr })` and log `"{pair} #{id}: {reason} → close trade"`.
  - Runs regardless of the Auto Entry toggle.
  - `exitLabel`: `cycle_done → "Cycle done"`, `pumped_away → "Pumped away"`, `range_broken → "Range broken"`, `volume_died → "Volume died"`, `max_hold → "Max hold"`.

- [ ] **Step 1: Write the failing tests**

```js
test("closes on range_broken once the timer persisted in state elapses (timer survives restart)", async () => {
  // trade with strategy.params (oorBelowMin 15), strategyState { aboveSince: null, belowSince: 0 }, live leg below range
  // runStrategyExits(positions, { deps: { closeTrade: spy }, now: 15 * 60000 }) → spy called with reason "range_broken"
});
test("first call stores the timer and does not close", async () => { /* getTrade(id).strategyState.belowSince === now */ });
test("runStrategyExits xIsSol leg", async () => { /* leg xIsSol true, activeBin below bin ids → pumped_away after timer */ });
test("cycle_done uses live flip legs", async () => { /* trade.flipLegs [F]; live F with range; active above → close */ });
test("skips locked trades, trades without strategy, and trades with no live leg", async () => { /* closeTrade never called */ });
test("runs while Auto Entry is OFF", async () => { /* setToggle("autoEntry", false) → still closes */ });
test("no candle fetch when lowVolumeBars is 0", async () => { /* deps.fetchCandles spy not called */ });
```

`telegram.test.js`: `exitLabel("cycle_done") === "Cycle done"` and the other four.

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-exit-loop.test.js test/telegram.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**; in `mainLoop` add after the auto flip block:
  ```js
  try { await runStrategyExits(positions); } catch (err) { log.error(`Strategy exit error: ${err.message}`); }
  ```
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(exit): strategy exits for auto trades`

---

### Task 14: Daily loss brake

**Files:**
- Modify: `src/strategy/runner.js`, `src/notify/telegram.js` (`notifyDailyBrake`)
- Test: `test/strategy-runner.test.js` (add)

**Interfaces:**
- Consumes: `todayAutoPnlSol`, `brakeHit` (Task 5), `setToggle`, `getPrice(WSOL_MINT)`, `periodStart`.
- Produces:
  - In `runScan`, before any profile: closed refs since `periodStart("today")` (live auto trades; in DRY_RUN closed paper trades, Task 16); `solUsd = await deps.getSolUsd()` (null on error); `pnl = todayAutoPnlSol(...)`; `brakeHit` → `setToggle("autoEntry", false)`, `notifyDailyBrake({ pnlSol: pnl, limitSol: g.dailyLossLimitSol })`, log, return.
  - `notifyDailyBrake({ pnlSol, limitSol })` text: `🛑 Daily loss limit hit ({pnlSol.toFixed(3)} SOL ≤ −{limitSol} SOL) — Auto Entry turned OFF. Open trades keep their exits.`

- [ ] **Step 1: Write the failing tests** — brake hit: toggle becomes off, notify called once, `fetchPoolRows` never called; just under the limit: scan proceeds; `getSolUsd` rejects and only USD-only losses exist → no brake; yesterday's losses ignored.
- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-runner.test.js` — Expected: new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(strategy): daily loss brake turns Auto Entry off`

---

### Task 15: Remove the old entry

**Files:**
- Delete: `src/entry/pool-list.js`, `src/entry/price-watch.js`, `src/entry/candidates.js`, `src/entry/execute.js`, `src/market/supertrend-state.js`; tests `test/pool-list.test.js`, `test/price-watch.test.js`, `test/entry-candidates.test.js`, `test/supertrend-state.test.js`, `test/supertrend-refresh.test.js`
- Modify: `src/config/index.js` (drop `BINS_BELOW`, `BINS_ABOVE`, `STRATEGY`, and `entry.poolListFile`, `defaultSizeSol`, `defaultMaxPositions`, `maxConcurrentBidaskDouble`, `scanIntervalSec`, `stAtrPeriod`, `stMultiplier`, `expiryHours`, `sizeSplit`, plus top-level `entryTouchTolerancePct`, `supertrendCacheFile`, `gmgnMaxStaleMin`); `src/config/strat-schema.js` (drop OVERRIDES `ENTRY_SIZE_SPLIT`, `ENTRY_SCAN_INTERVAL_SEC`, `ST_ATR_PERIOD`, `ST_MULTIPLIER`, `ENTRY_DEFAULT_SIZE_SOL`, `POOL_LIST_FILE`, `SUPERTREND_CACHE_FILE`, `GMGN_MAX_STALE_MIN`; drop `ENTRY_SCAN_INTERVAL_SEC` from RESTART_KEYS); `strat.conf` (delete sections *Auto Entry · Pools & sizing* and *Auto Entry · Signal*; move `JUPITER_POLL_INTERVAL_SEC` with its comment to *Market data & rate limits*; move `GAS_RESERVE` to *Auto Entry · Limits*; delete `GMGN_MAX_STALE_MIN`); `src/entry/index.js` (drop `deactivatePool`); `src/entry/pool-info.js` (drop `getPoolNames` and the `pool-list` import); `src/state/positions.js` (drop `countOpenBotPositionsByPool`); `src/exit/close.js` and `src/exit/index.js` (drop `deactivatePool` imports and calls); `src/lp/close-trade.js` (drop the `skipDeactivate` option it passes); `src/notify/telegram.js` (drop `notifyPoolExpired`, `notifyPoolUnsupported`); `src/index.js` (startup line → `Auto entry: degen {on/off} {sizeSol} SOL · multihour {on/off} {sizeSol} SOL · scan {scanIntervalSec}s`, comment `// Entry scanner (Meteora screener, bid-ask flip)`); `test/smoke.test.js` (remove deleted modules; add every `src/strategy/*.js` and `src/exit/strategy-exit.js`); `test/mode-repair.test.js` (delete the `entry/execute.js` test); `test/entry-quota.test.js` (delete the cases that call `countOpenBotPositionsByPool`); `test/strat-schema.test.js`, `test/settings.test.js`, `test/tg-strat-settings.test.js` (replace `ENTRY_SIZE_SPLIT` with `EVIL_PANDA_RSI_LEVEL` — range `0..100`, so the error text becomes `EVIL_PANDA_RSI_LEVEL must be a number between 0 and 100`, and the valid/invalid sample values become `"95"` / `"150"`; replace `ST_ATR_PERIOD` with `EVIL_PANDA_ST_ATR_PERIOD`; delete the `POOL_LIST_FILE` / `SUPERTREND_CACHE_FILE` file-type cases — no key uses the `file` type any more, and the `file` branch in `validateValue` stays as is); `test/config-reload.test.js` (override `AUTO_COOLDOWN_MIN: "30"` instead of `ENTRY_SIZE_SPLIT`, assert `config.autoEntry.cooldownMin === 30` and that `config.autoEntry` keeps identity); `README.md` (rewrite *Auto Entry* text in the toggles table, the sweep note and *Upgrading* bullet; add an **Auto Entry · bid-ask flip** section: profiles, screener, entry signal, flip, strategy exits, limits, brake, paper mode, backtester commands; remove pool.txt mentions); `src/tg/help.js` unchanged.

**Interfaces:** none new.

- [ ] **Step 1: Remove and edit** as listed. Grep must come back empty:
  Run: `git grep -n -E "pool-list|price-watch|entry/candidates|entry/execute|supertrend-state|POOL_LIST_FILE|ENTRY_SIZE_SPLIT|countOpenBotPositionsByPool|deactivatePool|notifyPoolExpired|getPoolNames|BINS_BELOW" -- src test scripts strat.conf README.md`
  Expected: no output.
- [ ] **Step 2: Run** `npm test` — Expected: PASS. `npm run lint` — Expected: no errors.
- [ ] **Step 3: Dry-run boot check** with a temp copy so production files are untouched:
  Run (PowerShell or bash, `DRY_RUN=true`, `STATE_FILE`/`SETTINGS_FILE` pointing to a temp dir): `node -e "import('./src/config/index.js').then(m=>console.log(Object.keys(m.default.autoEntry.profiles)))"`
  Expected: `[ 'degen', 'multihour' ]`.
- [ ] **Step 4: Commit** — `refactor(entry): remove pool.txt and Supertrend auto entry`

---

# Phase 3 — Paper mode and learning loop

### Task 16: Paper trades

**Files:**
- Create: `src/strategy/paper.js`
- Modify: `src/strategy/runner.js` (DRY_RUN path + paper refs for limits/brake), `src/exit/index.js` (tick paper trades each main-loop cycle, also when there are no live positions), `src/notify/telegram.js` (`notifyPaperClose`)
- Test: `test/strategy-paper.test.js`

**Interfaces:**
- Consumes: `PAPER_FILE`, `simulateTrade` (Task 7), `getPoolInfo`, `fetchCandles`, `closedBars`, `getPrice(WSOL_MINT)`, `appendStrategyLog` (Task 17 — until then a no-op import guarded by `deps.log`).
- Produces:
  - `PaperTrade = { id: "P{n}", profile, pool, pair, baseMint, openedAt, entryBarTime, p, rangePct, poolMeta: { binStep, baseFeePct, protocolFeePct, tvlUsd }, poolLiq: { [k]: sol }, entry: { metrics, signal }, closed, closedAt, closeReason, closePnlSol, closePnlPct, flipped, holdMin }` (`entryBarTime` = start of the next 5m bar after `openedAt`, sec)
  - `listPaperTrades({ open } = {}) → PaperTrade[]`
  - `openPaperTrade({ profile, p, row, rangePct, entry, deps }) → PaperTrade` — reads `pool.getActiveBin()` and `pool.getBinsBetweenLowerAndUpperBound(lower, upper)` for the planned range (orientation like `pctToBinRange`), stores pool liquidity per relative bin `k` (token-price orientation, `k = 0` = active) in SOL (`yAmount`/`xAmount` converted at the bin price, decimals from `getMintDecimals`); RPC failure → `poolLiq = {}` (sim falls back to the TVL estimate); sends `notifyAutoEntry({ …, paper: true })`.
  - `tickPaperTrades({ deps, now }) → PaperTrade[]` (closed this tick) — per open trade: bars `closedBars(fetchCandles(baseMint, pool, { resolution: "5m", limit: <bars since entryBarTime> + 2 }), now)` filtered to `time ≥ entryBarTime`; empty → skip; `res = simulateTrade({ bars, entryIndex: 0, p, pool: poolMeta, rangePct, solUsdAt: () => solUsd, sim: g.sim, poolLiqSolAt: (k) => poolLiq[k] ?? (poolMeta.tvlUsd / solUsd) · g.sim.poolDepthFactor / g.sim.poolSpreadBins })`; `res.exitReason` not in `["end_of_data", null]` → close (fields above), `notifyPaperClose`, `appendStrategyLog(paperLogRow(trade))`.
  - `notifyPaperClose(trade)` text: `📝 PAPER close · {profile} · {pair}\nReason: {exitLabel(reason)}\nPnL: {±x.xx}% ({±x.xxxx} SOL) · {holdMin}m{flipped ? " · flipped" : ""}`
  - Runner: in DRY_RUN, `open`/`closed` refs for `canOpen` and the brake come from `listPaperTrades` (paper trades carry `closePnlSol`).

- [ ] **Step 1: Write the failing tests** (temp `PAPER_FILE`, stubbed `getPoolInfo`/`fetchCandles`/notify)

```js
test("openPaperTrade stores entryBarTime, pool meta and per-bin liquidity", async () => { /* entryBarTime = floor(openedAt/300000)*300 + 300 */ });
test("RPC failure while reading bins → empty poolLiq, trade still opens", async () => {});
test("tick with no new bars leaves the trade open", async () => {});
test("tick closes on a strategy exit and logs + notifies once", async () => {
  // bars after entry dump below range for oorBelowMin → closed, closeReason "range_broken", closePnlSol < 0,
  // second tick: notify not called again
});
test("runner in DRY_RUN opens paper trades and counts them for maxOpen", async () => {});
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-paper.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**; in `mainLoop` call `tickPaperTrades()` (in try/catch) once per cycle in both the no-position branch and the normal branch, only when `config.dryRun`.
- [ ] **Step 4: Run** the test, then `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(strategy): paper trading in DRY_RUN`

---

### Task 17: Learning log and report

**Files:**
- Create: `src/strategy/log.js`, `scripts/strategy-report.js`
- Modify: `src/exit/index.js` (call `logSettledAutoTrades` each cycle), `src/strategy/paper.js` (use `appendStrategyLog`)
- Test: `test/strategy-log.test.js`

**Interfaces:**
- Consumes: `STRATEGY_LOG_FILE`, `simulateTrade`, `fetchCandles`, `listClosedTrades`, `markTradeStrategyLogged`, `getPrice`.
- Produces:
  - `DEPTH_FACTORS = [0.25, 0.5, 1, 2, 4]`
  - `appendStrategyLog(row) → void` (one JSON line, creates the file)
  - `readStrategyLog(file = STRATEGY_LOG_FILE) → Row[]` (bad lines skipped)
  - `Row = { ts, mode: "live"|"paper", profile, pool, pair, mint, params, entry, pnlPct, pnlSol, holdMin, flipped, exitReason, predicted: { [factor]: pnlPct } | null }`
  - `paperLogRow(trade) → Row` (`predicted: null`)
  - `logSettledAutoTrades({ deps, now }) → number` — closed trades with `origin === "auto"`, `strategy`, no `strategyLogged`, `now − closedAt ≥ 120000`: fetch 5m bars from the first bar at or after `openedAt` to `closedAt`, run `simulateTrade({ bars, entryIndex: 0, p: strategy.params, pool: strategy.entry.poolMeta, rangePct: strategy.entry.rangePct, stopAtSec: closedAt/1000, … })` once per `DEPTH_FACTORS` value (sim `poolDepthFactor` overridden), write the row (`pnlSol = closePnlUsd / solUsd`, `flipped = flipLegs?.length > 0`, `holdMin`), `markTradeStrategyLogged`. Candle fetch failure → row written with `predicted: null`.
  - `summarizeRows(rows) → { groups: Array<{ mode, profile, trades, winRate, meanPct, medianPct, flipRate, avgHoldMin, exitMix }>, buckets: { rangePct: [...], flipPct: [...] }, calibration: { factor: number, mae: number } | null }` — buckets by `params.rangePct` in 10-point steps and by `params.flipPct`; calibration = factor with the lowest mean absolute error between `predicted[factor]` and `pnlPct` over live rows (null when none).
  - CLI `node scripts/strategy-report.js [--profile <name>] [--since <YYYY-MM-DD>]` — prints the groups table, buckets and `Suggested SIM_POOL_DEPTH_FACTOR={factor} (MAE {mae}% over {n} live trades)`.

- [ ] **Step 1: Write the failing tests**

```js
test("append/read round trip skips bad lines", () => {});
test("logSettledAutoTrades waits 2 minutes, writes one row with 5 predictions, marks logged", async () => {});
test("candle failure still writes the row with predicted null", async () => {});
test("summarizeRows groups, buckets and picks the lowest-MAE factor", () => {
  const live = (pnl, pred) => ({ mode: "live", profile: "degen", pnlPct: pnl, params: { rangePct: 50, flipPct: 60 },
    flipped: false, holdMin: 10, exitReason: "tp", predicted: pred });
  const s = summarizeRows([live(5, { 0.25: 9, 0.5: 6, 1: 4, 2: 2, 4: 1 }), live(3, { 0.25: 8, 0.5: 3.5, 1: 2, 2: 1, 4: 0 })]);
  assert.equal(s.calibration.factor, 0.5);
});
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/strategy-log.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**; `mainLoop` calls `logSettledAutoTrades()` (try/catch, background `.catch` so it never blocks the loop) once per cycle.
- [ ] **Step 4: Run** the test, `npm test`, `npm run lint` — Expected: PASS / no errors. `node scripts/strategy-report.js` with no log file — Expected: `No strategy log yet.`
- [ ] **Step 5: Commit** — `feat(strategy): learning log, predicted PnL and report`

---

## Final verification (after Task 17)

- [ ] `npm test` — all pass. `npm run lint` — clean.
- [ ] Backtest end to end on a small set: `node scripts/backtest-flip.js fetch --profile degen --days 2 --max-pools 20` then `node scripts/backtest-flip.js run --profile degen --samples 50` — report and `best.conf` written.
- [ ] Paper boot (temp state/settings copies, `DRY_RUN=true`, Auto Entry ON) for ~10 minutes: log shows screener candidates in the summary and no errors; any paper entry produces a `📝 PAPER` alert.
- [ ] Nothing in `git status` under `data/`, `paper-trades.json`, `strategy-log.jsonl` (ignored).
