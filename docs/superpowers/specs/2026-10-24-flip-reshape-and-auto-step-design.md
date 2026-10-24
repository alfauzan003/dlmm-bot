# Flip re-shape + auto flip step — design

Date: 2026-10-24
Builds on: `2026-10-12-flip-trade-design.md` (Flip) and the auto flip feature (`src/exit/auto-flip.js`).

## Goal

1. **Re-shape:** every flip (manual 🔁 Flip and auto flip) gathers the *whole* token side of a trade —
   newly crossed bins of the original legs **and** all earlier flip legs — and re-deposits it as **one**
   bid-ask token position, so repeated flips give one smooth curve instead of a sawtooth.
2. **Auto flip step:** auto flip takes `start [step]` (e.g. `60 10` → flip at 60%, 70%, 80%, 90%, 100%).
   `start` alone keeps today's behaviour (flip once, then off).

## Decisions (agreed)

| Topic | Decision |
|---|---|
| Earlier flip legs on a new flip | Withdrawn too; re-deposited together with the new bins as one position |
| Earlier flip legs afterwards | Stay open and empty (no close tx); remain in `flipLegs`; rent returns on trade close |
| When there is something to flip | Only if an original (non-flip) leg has ≥ 1 token-only bin |
| Width cap | Unchanged: 70 bins nearest the active bin, across all legs |
| Auto flip input | `start [step]` or `off`; start 1–100, step 1–99 |
| Next threshold | Smallest `start + k·step` strictly above the current % crossed; > 100 → off |
| Auto Entry | Untouched (single `FLIP_PCT` per profile, no step) |

## 1. Bin selection (`src/lp/flip-trade.js`)

- Candidate bins: every open leg of the trade (original and flip legs; legs closed in state are
  ignored), bins strictly on the token side of the active bin (`baseIsX` → `> active`, else `< active`)
  with token > 0. Active bin never withdrawn or deposited into.
- Eligibility: at least one candidate bin belongs to a non-flip leg; otherwise `binCount: 0`
  ("Nothing to flip — no token-only bins yet."). A flip pressed right after a flip stays a no-op.
- Cap: 70 nearest the active bin across all candidate bins. Bins further away stay in place.
- New range: unchanged rule — `n` = bins selected; `baseIsX` → `[active+1, active+n]`, else
  `[active−n, active−1]`. One position, BidAsk, via `openTokenOnlyPosition` with explicit range.
- Withdraw: one `removeLiquidity` (bps 10000, `shouldClaimAndClose: false`) per leg with selected
  bins. Fees stay in each position. Earlier flip legs are left open (empty).
- Everything else in `flipTrade` is unchanged: lock, pool-busy refusal, fee-cap / SOL preflight,
  strict before-balance read, delta re-deposit, retries, keep-mint on failure, `DRY_RUN`.

## 2. PnL / state

- New position is added with `addTradeLeg(id, addr, { flip: true })`, as now.
- Earlier flip legs stay in `trade.positions` and `trade.flipLegs`. `aggregateTradePnl` already sums
  every open leg's `pnlUsd` and excludes flip-leg deposits from the denominator — unchanged.
- Auto Entry exit (`strategy-exit.js`, `cycle_done` = price above the top of flip legs) keeps working:
  empty legs keep their bin range and the new position covers the same top.

## 3. Auto flip step

- Stored: `trade.autoFlip = { pct, step? }` — `pct` is always the **next** threshold. No `step` = once.
- `settings.json`: `autoFlipStep` (`null` default) next to `autoFlipPct`; invalid → `null`.
  New `/open` `bid_ask` / `mixed` trades get `{ pct: autoFlipPct, step: autoFlipStep }` (step omitted
  when null). Auto Entry passes its own `{ pct }` and is unaffected.
- `runAutoFlips` after a result that is **success or dry run**:
  - no step → turn off (as now);
  - step → `next` = smallest `pct + k·step` (k ≥ 1) with `next > crossed%`; `next > 100` → off,
    else `setTradeAutoFlip(id, { pct: next, step })`.
- Busy (trade / pool) or thrown error → keep, retry next cycle (unchanged). Any other failure → off
  + notify (unchanged).

## 4. Telegram copy

- Parser `parseAutoFlipInput`: `"60"` → `{ on: true, pct: 60 }`; `"60 10"` → `{ on: true, pct: 60, step: 10 }`;
  `"off"` → `{ on: false }`; `%` suffix allowed on start; anything else → `null`.
- Buttons: `🤖 Auto flip 60/10` (step), `🤖 Auto flip 60%` (once), `🤖 Auto flip off`; same in `/settings`.
- Prompts:
  - trade: `Send the Auto flip % and optional step for trade #ID (e.g. 60 10 = flip at 60%, 70%, 80%…; 60 = once), or off.`
  - settings: `Send the default Auto flip % and optional step for new bid_ask / mixed trades (e.g. 60 10 = flip at 60%, 70%, 80%…; 60 = once), or off.`
- Manual flip result: `✅ Flipped N bins (X token) → one position over N bins.`
- Confirm screen: `Flip N bins → one token position over N bins above price.`
- Auto flip success / dry run messages end with `Next auto flip at P%.` or `Auto flip turned off.`

## 5. Tests

- Selection: includes flip-leg token bins; requires a non-flip candidate; 70 cap across original +
  flip legs; one contiguous range for the new position.
- `flipTrade`: second flip withdraws from the original leg and the earlier flip leg, opens one
  position, earlier flip leg stays in `positions` / `flipLegs`.
- `runAutoFlips`: step advances 60 → 70; fast drop 55 → 85 → next 90; past 100 → off; dry run steps
  too; no step → off after one flip; failure still turns off.
- Parser (one value, two values, off, invalid incl. step 0 / 100 / 3 values), settings default step
  (set / clear / invalid file value), `/open` applies the step, button labels and prompts.
