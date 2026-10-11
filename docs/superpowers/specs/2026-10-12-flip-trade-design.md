# Flip trade (bid-ask → token side) — design

Date: 2026-10-12

## Goal

When price drops through a `bid_ask` / `mixed` trade, bins it crossed now hold token instead of SOL.
"Flip" withdraws only those token bins and re-deposits the token as a single-sided BidAsk position
above the current price, so it sells back into SOL as price recovers. Liquidity shape changes; no
Jupiter swap is involved.

## Decisions (agreed)

| Topic | Decision |
|---|---|
| Where the new position goes | New leg of the **same trade** (same TP/SL/Trail, one PnL, one close) |
| Width of new position | **Mirror**: same bin count as withdrawn |
| Active bin | **Skipped** (never withdrawn, never deposited into) |
| Max width | **70 bins**, one position (`DEFAULT_BIN_PER_POSITION`, single tx) |
| Eligibility | Only trades with `trade.shape` ∈ {`bid_ask`, `mixed`} |

## 1. Rules

- 🔁 Flip button in trade detail only when `trade.shape` is `bid_ask` or `mixed`.
- Withdraw, per open leg (legs with `closed === true` in state are skipped), only fully-token bins:
  - `baseIsX` (token = X): bins `> active`.
  - token = Y: bins `< active`.
  - The active bin and bins with zero liquidity are skipped.
- Cap: across all legs, at most the **70 token-side bins nearest the active bin** are withdrawn.
  Bins further away stay in place.
- `n` = number of bins withdrawn. New position: one token-only BidAsk position over `n` bins on the
  token side, excluding the active bin:
  - `baseIsX`: `active+1 … active+n`.
  - token = Y: `active−n … active−1`.
- `n = 0` → reply "Nothing to flip — no token-only bins yet.", no transactions.
- Refused when the trade already has `MAX_TRADE_POSITIONS` (10) legs.

## 2. Flow — new `src/lp/flip-trade.js`

Exports a pure planner (bin selection + new range) and `flipTrade(trade, { deps })` (injectable deps,
like `claimTrade`).

1. `tryLockTrade(id, "flip")` → busy result when locked. `addEntryInProgressPool(pool)` and
   `addEntryInProgressMint(baseMint)` so the safety sweep does not sell the token and `syncTrades`
   does not adopt the new position as its own trade.
2. Plan (read-only): load pool + live leg bin data, select bins, compute new range. The Telegram
   confirm screen shows: "Flip N bins → new token position over N bins above price".
3. Withdraw: per leg with selected bins, `pool.removeLiquidity({ user, position, fromBinId, toBinId,
   bps: 10000, shouldClaimAndClose: false })`. Unclaimed fees remain in the position.
4. Measure: token balance after − before withdraw = amount to re-deposit (pre-existing wallet tokens
   are never used).
5. Re-deposit via `openTokenOnlyPosition`, extended with optional explicit `minBinId` / `maxBinId`
   (existing callers unchanged).
6. Record: append new address to `trade.positions` and to new field `trade.flipLegs`
   (lazy; old trades have none).
7. `finally`: remove entry-in-progress pool/mint, `unlockTrade`.

Failures:
- Withdraw fails on all legs → nothing changed, error result.
- Re-deposit fails → token stays in wallet and `addKeepMint(baseMint)` so the sweep won't sell it.
  Result: "Withdrawn but re-deposit failed — token kept in wallet". Trade stays open.

`DRY_RUN`: plan is computed and logged, no transactions.

## 3. PnL

Meteora reports the withdrawn value as a withdrawal on the old leg and the new leg as a fresh deposit.
`aggregateTradePnl` sums `pnlUsd` of all open legs (flip legs included) but **excludes `depositUsd` of
legs in `trade.flipLegs`** from the denominator. PnL% stays relative to the original deposit, so
TP/SL/Trail are unaffected. `settleTradeIfDone` already uses `t.depositUsd` — no change.

## 4. Interactions

- New leg is tracked with mode `bidask:token`. With Deterministic exit ON, `bidask:token` mode rules
  apply to it (same as per-mode rules already apply to `/open` legs). OFF (default): only trade
  TP/SL/Trail.
- Exit loop skips the trade while locked.
- Claim/close iterate `trade.positions` → new leg included automatically.

## 5. Telegram UI (`src/tg/positions.js`)

- `🔁 Flip` in the detail keyboard (eligible shapes only) → confirm screen (Flip / Cancel) via
  `registerConfirm("flip")` → `runAction` "⏳ Flipping…" →
  "✅ Flipped N bins (X token) → new position over N bins."

## 6. Tests

Use env overrides (`STATE_FILE`, etc.); never touch production files.

- Planner (pure): X vs Y side, active bin skipped, empty bins skipped, 70-bin cap across legs,
  mirrored new range.
- `aggregateTradePnl` excludes `flipLegs` deposits from the denominator.
- `flipTrade` with stubbed deps: busy lock, nothing to flip, re-deposit failure → keep-mint,
  success → leg added to `positions` + `flipLegs`.
- Add `src/lp/flip-trade.js` to `MODULES` in `test/smoke.test.js`.
