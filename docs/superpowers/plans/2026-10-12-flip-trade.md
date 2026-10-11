# Flip Trade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 🔁 Flip action in `/positions` that withdraws the token-only bins of a `bid_ask`/`mixed` trade and re-deposits that token as a mirrored single-sided BidAsk leg above the current price.

**Architecture:** New module `src/lp/flip-trade.js` holds pure bin selection, a read-only `planFlip`, and `flipTrade` (lock → withdraw → measure → re-deposit → record), all with injectable `deps` like `claimTrade`. Trade state gains `flipLegs`; `aggregateTradePnl` excludes their deposits. `src/tg/positions.js` adds the button + confirm flow.

**Tech Stack:** Node 24 ESM, `node --test`, `@meteora-ag/dlmm` 1.9.14, grammY.

**Spec:** `docs/superpowers/specs/2026-10-12-flip-trade-design.md`

## Global Constraints

- Eligible shapes: exactly `bid_ask` and `mixed` (`trade.shape`).
- Withdraw only bins strictly on the token side of the active bin (`baseIsX` → `binId > active`; else `binId < active`); active bin never withdrawn or deposited into.
- Max 70 bins withdrawn per flip (`FLIP_MAX_BINS = 70`), nearest to active first.
- New range: `baseIsX` → `[active+1, active+n]`; else `[active−n, active−1]`; `n` = bins withdrawn.
- Re-deposit amount = token balance after withdraw − before (never pre-existing wallet tokens).
- Refuse when `trade.positions.length >= MAX_TRADE_POSITIONS` (10, from `src/lp/open-trade.js`).
- `DRY_RUN`: plan only, no transactions.
- Tests use `STATE_FILE`/`DECISION_LOG_FILE`/`PNL_HISTORY_FILE` env overrides into a tmp dir (pattern: `test/close-trade.test.js`). Never touch production state files, never run `npm start`.
- User-facing copy (exact):
  - nothing: `Nothing to flip — no token-only bins yet.`
  - re-deposit failed: `⚠️ Withdrawn but re-deposit failed — token kept in wallet.`
  - success: `✅ Flipped N bins (X token) → new position over N bins.`
  - confirm: `Flip N bins → new token position over N bins above price.`

## Review Focus

- Active bin moves between confirm and execution → `flipTrade` re-plans inside the lock with fresh data, never reuses the confirm-screen plan (Task 3 test `flipTrade re-plans with fresh pool data`).
- RPC balance lags after withdraw (diff reads 0) → retry balance reads; still 0 → `redepositFailed` + keep-mint, trade stays open (Task 3 test `balance never increases → redepositFailed + keepMint`).
- Only flip legs remain open (old legs closed by mode rules) → PnL must not become permanently unknown; fall back to including flip-leg deposits (Task 2 test `only flip legs open → their deposits are used`).
- Wallet already holds the token (kept fees) → only the delta is re-deposited (Task 3 test `re-deposits only the withdrawn delta`).
- Exception mid-flow (deposit throws) → lock and entry-in-progress guards released (Task 3 test `releases lock and guards when deposit throws`).

---

### Task 1: Pure bin selection

**Files:**
- Create: `src/lp/flip-trade.js`
- Create: `test/flip-trade.test.js`
- Modify: `test/smoke.test.js` (add `"../src/lp/flip-trade.js"` to `MODULES`)

**Interfaces:**
- Produces:
  - `export const FLIP_MAX_BINS = 70`
  - `export const FLIP_SHAPES = ["bid_ask", "mixed"]`
  - `export function canFlip(trade): boolean` — `FLIP_SHAPES.includes(trade?.shape)`
  - `export function selectFlipBins({ legs, activeBinId, baseIsX, maxBins = FLIP_MAX_BINS })`
    - `legs: [{ position: string, bins: [{ binId: number, tokenAmount: number }] }]` (`tokenAmount` = raw token-side amount in that bin, X if `baseIsX` else Y)
    - returns `{ binCount: number, legs: [{ position, fromBinId, toBinId }] }` — only legs with ≥1 selected bin; `fromBinId <= toBinId`.
  - `export function flipRange(activeBinId, n, baseIsX): { minBinId, maxBinId }`

Selection algorithm: collect `(position, binId)` for every bin with `tokenAmount > 0` on the token side (strictly); sort by distance `|binId − activeBinId|` ascending; take first `maxBins`; group by position; each leg's range = min..max of its selected binIds.

- [ ] **Step 1: Write failing tests in `test/flip-trade.test.js`**

```js
test("selectFlipBins: baseIsX takes bins above active, skips active and empty", () => {
  const r = selectFlipBins({
    activeBinId: 100, baseIsX: true,
    legs: [{ position: "P1", bins: [
      { binId: 98, tokenAmount: 0 }, { binId: 100, tokenAmount: 5 },
      { binId: 101, tokenAmount: 3 }, { binId: 102, tokenAmount: 0 }, { binId: 103, tokenAmount: 2 }] }],
  });
  assert.deepEqual(r, { binCount: 2, legs: [{ position: "P1", fromBinId: 101, toBinId: 103 }] });
});
test("selectFlipBins: token Y takes bins below active", () => {
  // bins 97..99 with token, 100 active, 101 with token → only 97..99, binCount 3
});
test("selectFlipBins: caps at maxBins nearest active across legs", () => {
  // P1 bins 101..140, P2 bins 141..200 all tokenAmount 1, maxBins 70
  // → binCount 70, P1 101..140, P2 141..170
});
test("selectFlipBins: nothing on token side → binCount 0, legs []", () => {});
test("flipRange mirrors on the token side", () => {
  assert.deepEqual(flipRange(100, 5, true), { minBinId: 101, maxBinId: 105 });
  assert.deepEqual(flipRange(100, 5, false), { minBinId: 95, maxBinId: 99 });
});
test("canFlip only for bid_ask and mixed", () => {
  // bid_ask, mixed → true; spot, curve, null, undefined trade → false
});
```

File header must set `STATE_FILE`/`DECISION_LOG_FILE`/`PNL_HISTORY_FILE` to a tmp dir before dynamic imports (Task 3 adds state tests here).

- [ ] **Step 2: Run `node --test test/flip-trade.test.js`** — Expected: FAIL (module not found).
- [ ] **Step 3: Implement the four exports above in `src/lp/flip-trade.js`** (top comment in Indonesian like sibling files); add to smoke `MODULES`.
- [ ] **Step 4: Run `node --test test/flip-trade.test.js test/smoke.test.js`** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(flip): pure bin selection for trade flip`

---

### Task 2: Trade state `flipLegs` + PnL exclusion

**Files:**
- Modify: `src/state/trades.js` (new export)
- Modify: `src/exit/trade-exit.js:7-20` (`aggregateTradePnl`)
- Test: `test/trades.test.js`, `test/trade-exit.test.js`

**Interfaces:**
- Produces: `export function addTradeLeg(id, address, { flip = false } = {}): trade | null` — appends `address` to `t.positions` (no duplicate); if `flip`, appends to `t.flipLegs` (created lazily as `[]`). Returns null for missing/closed trade.
- `aggregateTradePnl(trade, positionsByAddr, opts)` — same signature/return. `pnlUsd` sums all open legs; `depositUsd` sums only open legs **not** in `trade.flipLegs`; if that sum is 0 but flip legs have deposits, use the flip-leg deposit sum instead.

- [ ] **Step 1: Write failing tests**
  - trades: `addTradeLeg adds a flip leg to positions and flipLegs`; `addTradeLeg without flip leaves flipLegs untouched`; `addTradeLeg on a closed trade returns null`.
  - trade-exit:
    - `flip leg deposit is excluded from the denominator`: trade `{ positions: ["A","F"], flipLegs: ["F"] }`, A `{pnlKnown:true, pnlUsd: 10, depositUsd: 100}`, F `{pnlKnown:true, pnlUsd: 2, depositUsd: 40}` → `{ pnlUsd: 12, depositUsd: 100, pnlPct: 12 }`.
    - `only flip legs open → their deposits are used`: A closed via `isClosed`, F as above → `{ pnlUsd: 2, depositUsd: 40, pnlPct: 5 }`.
    - existing tests unchanged (trades without `flipLegs`).
- [ ] **Step 2: Run `node --test test/trades.test.js test/trade-exit.test.js`** — Expected: new tests FAIL.
- [ ] **Step 3: Implement** both changes.
- [ ] **Step 4: Run `npm test`** — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(trades): flip legs excluded from trade deposit`

---

### Task 3: `planFlip` + `flipTrade`

**Files:**
- Modify: `src/meteora/open-token-position.js` — `openTokenOnlyPosition` accepts optional `minBinId`, `maxBinId`; when both are finite they replace `fallbackBinRange(...)`. Existing callers unchanged.
- Modify: `src/lp/flip-trade.js`
- Test: `test/flip-trade.test.js`

**Interfaces:**
- Consumes: Task 1 exports; `addTradeLeg` (Task 2); `getTrade`, `tryLockTrade`, `unlockTrade` (`src/state/trades.js`); `getTrackedPosition` (`src/state/positions.js`); `addEntryInProgressPool/Mint`, `removeEntryInProgressPool/Mint` (`src/entry/runtime.js`); `addKeepMint` (`src/state/keep-mints.js`); `MAX_TRADE_POSITIONS` (`src/lp/open-trade.js`).
- Produces:
  - `export async function planFlip(trade, { deps } = {})` → one of
    - `{ error: string }` (not eligible / `too many positions (10)` / pool load failure)
    - `{ binCount: 0 }`
    - `{ binCount, legs: [{position, fromBinId, toBinId}], newRange: {minBinId, maxBinId}, activeBinId, baseIsX }`
  - `export async function flipTrade(trade, { deps } = {})` → `{ success: boolean, busy?, error?, dryRun?, redepositFailed?, binCount, tokenAmount?, position? }`
- Default deps (all overridable in tests): `loadPool(poolAddress) → { pool, baseIsX }` (via `getPoolInfo`), `readLegs(pool) → { activeBinId, legs: [{ position, bins: [{binId, tokenAmount}] }] }` (via `pool.getPositionsByUserAndLbPair(wallet.publicKey)`, mapping `positionData.positionBinData` → `{ binId, tokenAmount: Number(baseIsX ? positionXAmount : positionYAmount) }`), `removeBins(pool, { position, fromBinId, toBinId })` (`pool.removeLiquidity({ user, position, fromBinId, toBinId, bps: new BN(10000), shouldClaimAndClose: false })`, each tx via `sendAndConfirmRobust` + fresh `buildFeePlan()`, pattern `src/meteora/claim.js`), `getTokenBalance`, `openTokenOnlyPosition`, `addKeepMint`, `sleep`, `dryRun` (`config.dryRun`).

Rules:
- `planFlip`: legs with `getTrackedPosition(addr)?.closed === true` are ignored; only the trade's own positions are considered.
- `flipTrade` order: `tryLockTrade(id, "flip")` (busy → `{ success:false, busy:true, binCount:0 }`) → re-read trade via `getTrade` → add pool+mint guards → `planFlip` (fresh) → `binCount 0` or `error` → return → `dryRun` → `{ success:true, dryRun:true, binCount }` → balance before → `removeBins` per leg (a failed leg is logged, others continue) → balance after, re-read up to 3× with `sleep(2000)` while `after <= before` → `delta = after − before`; `delta <= 0` and every leg failed → `{ success:false, error:"withdraw failed" }`; `delta <= 0` otherwise → `redepositFailed` + `addKeepMint` → `openTokenOnlyPosition({ poolAddress, baseMint, tokenAmountUi: delta, minBinId, maxBinId, distribution: "bid_ask", pairName })` → failure → `addKeepMint`, `{ success:false, redepositFailed:true, binCount, tokenAmount: delta }` → success → `addTradeLeg(id, position, { flip: true })` → `{ success:true, binCount, tokenAmount: delta, position }`. `finally`: remove guards, `unlockTrade`.

- [ ] **Step 1: Write failing tests** (stub deps; `trackPosition` + `createTrade` with `shape: "bid_ask"` for setup):
  - `planFlip refuses ineligible shape and full trades`
  - `planFlip ignores legs closed in state`
  - `flipTrade returns busy when the trade is locked`
  - `flipTrade with nothing to flip sends no tx`
  - `flipTrade in dry run removes nothing`
  - `flipTrade re-plans with fresh pool data` (readLegs called inside flipTrade; its active bin is the one used for `newRange`)
  - `re-deposits only the withdrawn delta` (balance 50 → 80 → `tokenAmountUi: 30`, explicit `minBinId/maxBinId` passed)
  - `success adds the leg to positions and flipLegs`
  - `balance never increases → redepositFailed + keepMint` (sleep stubbed)
  - `open failure → redepositFailed + keepMint, trade unchanged`
  - `releases lock and guards when deposit throws` (`tradeLock(id) === null`, `isEntryInProgressPool(pool) === false` after rejection)
- [ ] **Step 2: Run `node --test test/flip-trade.test.js`** — Expected: new tests FAIL.
- [ ] **Step 3: Implement** `planFlip`, `flipTrade`, and the `openTokenOnlyPosition` option.
- [ ] **Step 4: Run `npm test`** — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(flip): withdraw token bins and re-deposit as token-side leg`

---

### Task 4: Telegram Flip button + confirm flow

**Files:**
- Modify: `src/tg/positions.js` (`deps`, `buildTradeDetail`, `register`)
- Test: `test/tg-positions.test.js`

**Interfaces:**
- Consumes: `canFlip`, `planFlip`, `flipTrade` (Tasks 1, 3).
- Produces: `deps.planFlip`, `deps.flipTrade` on the exported `deps` object.

Behaviour:
- `buildTradeDetail`: when `canFlip(trade)`, the Close row becomes `[["❌ Close", "pos:close:ID"], ["🔁 Flip", "pos:flip:ID"]]`; otherwise unchanged (existing "documented buttons" test with `shape: "spot"` must still pass untouched).
- `pos:flip:ID` (withGuard "Flip"): not open → `notOpen`; `deps.planFlip(trade)`; `error` → edit `screen(id, "⚠️ Could not flip: <esc(error)>")` + `resultKeyboard`; `binCount 0` → `Nothing to flip — no token-only bins yet.` + `resultKeyboard`; else edit to confirm copy with buttons `Flip` → `ok:${session.issueToken({ action: "flip", id })}` and `Cancel` → `pos:open:ID`.
- `registerConfirm("flip")`: `runAction` with progress `⏳ Flipping…`, label `Flip`, `work: () => deps.flipTrade(trade)`, `describe: describeFlip`.
- `describeFlip(res)`: busy → `BUSY`; `dryRun` → `🧪 DRY RUN — would flip N bins → new position over N bins.`; `redepositFailed` → re-deposit copy; `binCount === 0` → nothing copy; `!success` → `⚠️ Could not flip: <error>`; success → success copy with `X` = `tokenAmount` formatted via `Number(x).toLocaleString("en-US", { maximumFractionDigits: 4 })`.

- [ ] **Step 1: Write failing tests**
  - `buildTradeDetail shows Flip only for bid_ask and mixed`
  - `flip confirm shows the planned bin count` (stub `deps.planFlip` → `{ binCount: 12, ... }`; edit text includes `Flip 12 bins → new token position over 12 bins above price.`)
  - `flip with nothing to flip shows the nothing message and no confirm token`
  - `flip token is one-shot and reports success` (stub `deps.flipTrade` → `{ success:true, binCount:12, tokenAmount:1234.5, position:"New" }`; second press → "This button expired — start again"; final text includes `✅ Flipped 12 bins (1,234.5 token) → new position over 12 bins.`)
  - `flip re-deposit failure shows the kept-in-wallet message`
- [ ] **Step 2: Run `node --test test/tg-positions.test.js`** — Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run lint && npm run format:check`** — Expected: all PASS / clean.
- [ ] **Step 5: Commit** `feat(tg): flip button in trade detail`
