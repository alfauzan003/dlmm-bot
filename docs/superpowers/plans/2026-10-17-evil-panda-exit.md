# Evil Panda Exit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-trade "Evil Panda" exit: after the 15m Supertrend support breaks, close the trade on the next
RSI / MACD / BB spike, configurable from `/settings → 🐼 Exit strategy`.

**Architecture:** Pure indicator math (`src/market/indicators.js`, `supertrendSeries`), a pure per-bar state
machine (`src/exit/evil-panda.js`), and a runner called once per tick of the existing position monitor
(`src/exit/index.js`) that fetches 15m candles through `fetchCandles` and closes through `closeTrade`.
Parameters are a new strat.conf section edited by the existing strategy editor.

**Tech Stack:** Node.js ESM, `node --test`, grammY, ESLint, Prettier (printWidth 120).

**Spec:** `docs/superpowers/specs/2026-10-17-evil-panda-exit-design.md`

## Global Constraints

- Change as little as possible outside this feature (AGENTS.md). No tidy-ups.
- Tests never send transactions; inject deps like `trade-loop.test.js` does.
- Comments in the surrounding code are Indonesian; match that in `src/`. User-facing text (Telegram, strat.conf,
  README) is English.
- Close reasons: `evil_panda_rsi`, `evil_panda_macd`, `evil_panda_bb`.
- Bars are 15m (`900` s); only closed bars are used.
- Run tests with `npm test`; lint with `npx eslint src test`; format check with
  `npx prettier --check --end-of-line auto src test`.

## Review Focus

1. Trade older than the 90 fetched candles (or opened during Supertrend warm-up) — early bars must not arm from
   warm-up noise: first `2 * stAtrPeriod` bars are treated as unknown (Task 3 test).
2. Close fails (busy / leg error) — same bar fires again next tick, not lost (Task 4 test).
3. Candle data where the latest closed bar is missing (GMGN late) — runner waits, does not advance `lastBar`
   (Task 4 test).
4. User toggles Panda off then on for a trade — progress resets so an old `armed` cannot close instantly
   (Task 2 test).
5. Two trades on the same mint — one candle fetch per tick (Task 4 test).

---

### Task 1: Indicators and Supertrend series

**Files:**

- Create: `src/market/indicators.js`
- Modify: `src/market/supertrend.js` (add `supertrendSeries`; `computeSupertrend` unchanged in behaviour)
- Test: `test/indicators.test.js`, `test/supertrend.test.js`

**Interfaces:**

- Produces:
  - `rsi(closes: number[], length: number) → (number|null)[]` — Wilder; seed = mean of first `length` changes
    at index `length`; avgLoss 0 → 100.
  - `macd(closes, fast, slow, signal) → { macd: (number|null)[], signal: (number|null)[], hist: (number|null)[] }`
    — EMAs seeded with SMA; `macd` from index `slow-1`, `hist` from `slow+signal-2`.
  - `bollinger(closes, length, stdDev) → { middle, upper, lower }` arrays, population stdev, from index `length-1`.
  - `supertrendSeries(candles, period, multiplier) → ({ direction, line } | null)[]` aligned to candles; last
    non-null element deep-equals `computeSupertrend(candles, period, multiplier)`.

- [ ] **Step 1: Write failing tests**

```js
test("rsi Wilder", () => assert.deepEqual(rsi([1, 2, 3, 2, 3], 2), [null, null, 100, 50, 75]));
test("bollinger", () => {
  const b = bollinger([1, 2, 3, 4], 2, 2);
  assert.equal(b.upper[0], null);
  assert.deepEqual([b.middle[1], b.upper[1], b.lower[1]], [1.5, 2.5, 0.5]);
  assert.equal(b.upper[3], 4.5);
});
test("macd on a linear series", () => {
  const closes = Array.from({ length: 40 }, (_, i) => i + 1);
  const m = macd(closes, 3, 6, 3);
  assert.equal(m.macd[4], null);
  assert.ok(Math.abs(m.macd[5] - 1.5) < 1e-9);
  assert.equal(m.hist[6], null);
  assert.ok(Math.abs(m.hist[7]) < 1e-9);
});
test("macd flat series is zero", () => {
  const m = macd(Array(40).fill(5), 12, 26, 9);
  assert.equal(m.hist.at(-1), 0);
});
// supertrend.test.js
test("supertrendSeries last equals computeSupertrend", () => {
  /* reuse an existing candle fixture from supertrend.test.js */
  assert.deepEqual(supertrendSeries(c, 10, 3).at(-1), computeSupertrend(c, 10, 3));
  assert.equal(supertrendSeries(c, 10, 3)[9], null);
});
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/indicators.test.js test/supertrend.test.js` —
      expect FAIL (missing exports).
- [ ] **Step 3: Implement** `indicators.js`; refactor the loop in `computeSupertrend` into `supertrendSeries` and
      have `computeSupertrend` return its last element (or null).
- [ ] **Step 4: Run** the same command — PASS; then `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(market): RSI, MACD, Bollinger and Supertrend series`

### Task 2: Config, strat.conf section and trade state

**Files:**

- Modify: `strat.conf` (new section right before `# ===== Transactions =====`),
  `src/config/strat-schema.js` (OVERRIDES), `src/config/index.js` (`evilPanda`), `src/state/settings.js`
  (`exitPresetForNewTrade`), `src/exit/trade-loop.js` (`exitAllOff`), `src/state/trades.js`,
  `src/notify/telegram.js` (`exitLabel`), `README.md`
- Test: `test/strat-schema.test.js`, `test/settings.test.js`, `test/trades.test.js`, `test/telegram.test.js`,
  `test/config-reload.test.js`

**Interfaces:**

- Produces:
  - strat.conf section title exactly `Exit strategy · Evil Panda`, with a section description and help text per
    key; keys and defaults as in the spec.
  - OVERRIDES: `EVIL_PANDA_ST_ATR_PERIOD`, `_RSI_LENGTH`, `_MACD_FAST`, `_MACD_SLOW`, `_MACD_SIGNAL` →
    `{ min: 1, int: true }`; `_BB_LENGTH` → `{ min: 2, int: true }`; `_RSI_LEVEL` → `{ min: 0, max: 100 }`;
    `_ST_MULTIPLIER`, `_BB_STDDEV` → `{ gt: 0 }`. None in `RESTART_KEYS`.
  - `config.evilPanda = { defaultOn, stAtrPeriod, stMultiplier, rsi: { on, length, level }, macd: { on, fast,
slow, signal }, bb: { on, length, stdDev } }` (defaults false/10/3/true,2,90/false,12,26,9/false,20,2).
  - `exitPresetForNewTrade()` adds `panda: { on: autoExit && config.evilPanda.defaultOn }`; `exitAllOff()` adds
    `panda: { on: false }`.
  - `setTradePanda(id, on: boolean) → trade|null` — sets `exit.panda = { on }`, deletes `trade.panda`.
  - `updateTradePanda(id, progress: { seenAbove, armed, lastBar }) → trade|null`.
  - `exitLabel`: `evil_panda_rsi` → `"Evil Panda (RSI)"`, `_macd` → `"Evil Panda (MACD)"`, `_bb` →
    `"Evil Panda (BB)"`.

- [ ] **Step 1: Write failing tests**
  - strat-schema: `validateValue("EVIL_PANDA_RSI_LEVEL","101",schema).ok === false`,
    `"EVIL_PANDA_RSI_LENGTH","1.5"` false, `"EVIL_PANDA_BB_STDDEV","0"` false; section
    `"Exit strategy · Evil Panda"` exists in committed strat.conf.
  - settings: Auto Exit ON + override `EVIL_PANDA_DEFAULT_ON=true` → `exitPresetForNewTrade().panda.on === true`;
    Auto Exit OFF → false; default (no override) → false.
  - trades: `updateTradePanda(id,{armed:true,seenAbove:true,lastBar:900})` then `setTradePanda(id,false)` then
    `setTradePanda(id,true)` → `trade.exit.panda.on === true` and `trade.panda === undefined`.
  - telegram: `exitLabel("evil_panda_macd") === "Evil Panda (MACD)"`.
  - config-reload: `config.evilPanda` keeps identity after `reloadConfig()` and picks up a changed
    `EVIL_PANDA_RSI_LEVEL` override.
- [ ] **Step 2: Run** those test files — FAIL.
- [ ] **Step 3: Implement** as listed. README: short "Exit strategy · Evil Panda" section (the three steps, the
      signals, per-trade button) and the new strat.conf section in the sections list.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(exit): Evil Panda settings and per-trade state`

### Task 3: Evil Panda evaluator

**Files:**

- Create: `src/exit/evil-panda.js`
- Test: `test/evil-panda.test.js`

**Interfaces:**

- Consumes: Task 1 functions; `config.evilPanda` shape (passed in as `params`, never imported here).
- Produces:
  - `pandaRows(closedCandles, params) → Row[]`, `Row = { time, close, direction: "bullish"|"bearish"|null, rsi,
hist, prevHist, upper }` (indicator fields null when unknown). `direction` is null for index `< 2 *
params.stAtrPeriod`. MACD fields null when `macd.slow <= macd.fast`.
  - `stepPanda(progress, rows, params, { openedAtSec }) → { progress, fire: null | { signal: "rsi"|"macd"|"bb",
time } }`. `progress` defaults `{ seenAbove: false, armed: false, lastBar: null }`. Processes rows with
    `time > lastBar` (when `lastBar` null: `time >= floor(openedAtSec / 900) * 900`) in the order the spec gives;
    on fire, returned `lastBar` stays at the previous row's time (not the firing row). Returns a new object; does
    not mutate input.
  - `closedBars(candles, nowMs) → candles | null` — drops bars whose start ≥ current bar start; null when the last
    remaining bar is not `currentBarStart - 900` (same rule as `supertrendFromClosed`).

- [ ] **Step 1: Write failing tests** (`row(t, dir, extra)` helper builds rows with `time = t * 900`; params with
      `rsi: { on: true, level: 90 }`, macd/bb off unless stated):
  - `bearish start never arms`: rows bearish ×3 with rsi 95 → `fire === null`, `armed === false`.
  - `bull then bear arms`: bullish, bearish(rsi 50) → `armed === true`, `fire === null`, `lastBar === 2*900`.
  - `armed + rsi spike fires`: bullish, bearish, bearish(rsi 95) → `fire.signal === "rsi"`, `progress.lastBar ===
2*900`.
  - `back above disarms and does not fire`: bullish, bearish, bullish(rsi 99) → `fire === null`,
    `armed === false`.
  - `macd first green`: macd on, rsi off: armed then row `{ hist: 0.1, prevHist: -0.2 }` fires `"macd"`; row
    `{ hist: 0.2, prevHist: 0.1 }` does not.
  - `bb close above upper`: bb on: `{ close: 2, upper: 1.5 }` fires `"bb"`.
  - `disabled signal ignored`: rsi off, rsi 99 → no fire.
  - `bars before open ignored`: openedAtSec = 3*900, bullish at t=1, bearish at t=3 → not armed.
  - `null direction skipped`: row direction null between bullish and bearish keeps state, advances `lastBar`.
  - `replay from lastBar`: progress `lastBar = 2*900` skips rows ≤ 2.
  - `pandaRows warm-up`: 60 synthetic candles, `stAtrPeriod 10` → rows[19].direction null, rows[20] non-null.
  - `closedBars`: drops the forming bar; returns null when the last closed bar is two bars old.
- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/evil-panda.test.js` — FAIL.
- [ ] **Step 3: Implement** `evil-panda.js`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(exit): Evil Panda evaluator`

### Task 4: Runner in the position monitor

**Files:**

- Modify: `src/exit/evil-panda.js` (add runner), `src/exit/trade-loop.js` (export `rereadTrade`), `src/exit/index.js`
  (call runner after `runAutoFlips`, same try/catch style)
- Test: `test/evil-panda.test.js`

**Interfaces:**

- Consumes: Task 2 `updateTradePanda`, `config.evilPanda`; Task 3 functions; `listOpenTrades`, `tradeLock`
  (`state/trades.js`); `rereadTrade(trade, live: Map, fetchPnl)` (now exported); `closeTrade`.
- Produces: `runEvilPanda(positions, { deps = {}, now = Date.now() } = {}) → Promise<Set<tradeId>>` (ids it tried
  to close). `deps`: `fetchCandles`, `fetchPoolPnl`, `closeTrade`.

Behaviour (from spec): trades with `exit.panda.on`, unlocked, with a live leg; skip without fetching when
`trade.panda?.lastBar >= latestClosedBarStart`; one `fetchCandles(baseMint, pool, { resolution: "15m", limit: 90,
allowStale: false })` per mint per call; `closedBars` null → skip, no progress write; write progress only if
changed; info log on arm / disarm (`"<pair> #<id>: Evil Panda armed (Supertrend broke)"` / `"... disarmed (back
above Supertrend)"`); on fire: `rereadTrade`, null → warn and skip; else `closeTrade(trade, { reason:
\`evil_panda_${signal}\`, swap: true, positionsByAddr })`, errors logged. When `macd.on && macd.slow <= macd.fast`, warn once per process (`EVIL_PANDA_MACD_SLOW must be
greater than EVIL_PANDA_MACD_FAST — MACD signal off`).

- [ ] **Step 1: Write failing tests** (temp `STATE_FILE`, create trades with `createTrade`, fake deps counting
      calls; candles from a fixture whose last closed bar is bullish→bearish with RSI(2) > 90):
  - `no new bar → no fetch`: progress `lastBar` = latest closed bar → `fetchCandles` not called.
  - `fires and closes with evil_panda_rsi`: closeTrade called once with `reason === "evil_panda_rsi"`.
  - `close failure retries next tick`: closeTrade throws on call 1; second `runEvilPanda` calls it again.
  - `late data waits`: candles missing the latest closed bar → no close, `trade.panda` unchanged.
  - `locked trade skipped`: `tryLockTrade(id, "close")` → no fetch, no close.
  - `one fetch per mint`: two trades same `baseMint` → `fetchCandles` called once.
  - `panda off → ignored`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** runner, export `rereadTrade`, wire into `src/exit/index.js`; add the module to
      `test/smoke.test.js` if that file lists exit modules.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(exit): run Evil Panda in the position monitor`

### Task 5: Telegram

**Files:**

- Modify: `src/tg/settings.js` (button + `set:exit` screen), `src/tg/strat-settings.js` (Back target),
  `src/tg/positions.js` (button, armed line, callback), `src/tg/help.js` (one line)
- Test: `test/tg-settings.test.js`, `test/tg-strat-settings.test.js`, `test/tg-positions.test.js`

**Interfaces:**

- Consumes: `loadStratSchema`, `setTradePanda`, `config.evilPanda.defaultOn` (effective value).
- Produces:
  - `/settings` main keyboard gets `🐼 Exit strategy` → callback `set:exit`, on its own row before `🧩 Strategy`.
  - `buildExitStrategies(schema) → { text, keyboard }`: text explains Exit strategies run per trade next to
    TP/SL/Trail; one button `🐼 Evil Panda (new trades: on|off)` → `st:s:<index of section "Exit strategy · Evil
Panda">:0`; `◀ Back` → `set:back`. Section missing → button omitted.
  - `buildStratSection`: sections whose title starts with `Exit strategy` get `⬅ Exit strategy` → `set:exit`
    instead of `⬅ Sections` → `st:home`.
  - Trade card: button `🐼 Panda on|off` → `pos:panda:<id>` on the TP/SL/Trail row's next row; text line
    `🐼 Evil Panda armed — waiting for a spike` when `exit.panda.on && panda.armed`. Callback toggles via
    `setTradePanda` and re-renders with `showDetail(ctx, trade, true)`.
- [ ] **Step 1: Write failing tests**: settings keyboard contains `set:exit`; `buildExitStrategies` button data is
      `st:s:<i>:0` for a schema with that section and absent without it; Exit strategy section's back is `set:exit`
      while other sections keep `st:home`; trade card shows `🐼 Panda off` for a trade without `exit.panda`, the
      armed line when armed; `pos:panda:<id>` flips `exit.panda.on`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npx eslint src test`, `npx prettier --check --end-of-line auto src test` — all
      clean (the pre-existing `src/entry/index.js` Prettier warning excepted).
- [ ] **Step 5: Commit** `feat(tg): Exit strategy settings and per-trade Evil Panda button`

### Task 6: Final verification

- [ ] **Step 1:** `npm test` — all pass; report the count.
- [ ] **Step 2:** Tell the user to try it with `DRY_RUN=true` before live use (the agent does not run `npm start`).
