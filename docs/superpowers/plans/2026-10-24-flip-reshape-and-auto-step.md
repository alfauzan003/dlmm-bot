# Flip Re-shape + Auto Flip Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every flip re-deposits the whole token side (new bins + earlier flip legs) as one bid-ask position, and auto flip accepts `start [step]` to flip again every `step`%.

**Architecture:** `planFlip` in `src/lp/flip-trade.js` stops excluding flip legs from bin selection but still requires a non-flip candidate bin; `flipTrade` is otherwise unchanged. Auto flip stores `{ pct, step? }` (pct = next threshold); `runAutoFlips` advances it after success / dry run. Parser, settings default, `/open` default and Telegram labels/prompts carry the optional step.

**Tech Stack:** Node 24 ESM, `node --test`, grammY.

**Spec:** `docs/superpowers/specs/2026-10-24-flip-reshape-and-auto-step-design.md`

## Global Constraints

- Tests use `STATE_FILE` / `DECISION_LOG_FILE` / `PNL_HISTORY_FILE` / `SETTINGS_FILE` tmp overrides; never touch production files; never run `npm start`.
- Auto Entry (`src/strategy/*`, `strat.conf`) is not modified.
- start 1–100, step 1–99; next threshold = smallest `pct + k·step` (k ≥ 1) strictly above crossed%; `> 100` → off.
- Copy (exact):
  - confirm: `Flip N bins → one token position over N bins above price.`
  - manual result: `✅ Flipped N bins (X token) → one position over N bins.`
  - manual dry run: `🧪 DRY RUN — would flip N bins → one position over N bins.`
  - auto success: `🤖 Auto flip #ID PAIR at P% crossed: flipped N bins (X token) → one position over N bins. <tail>`
  - auto dry run: `🧪 DRY RUN — auto flip #ID PAIR at P% crossed would flip N bins. <tail>`
  - `<tail>` = `Next auto flip at Q%.` or `Auto flip turned off.`
  - auto failure (unchanged): `⚠️ Auto flip #ID PAIR at P% crossed failed: <reason>. Auto flip turned off.`
  - labels: `🤖 Auto flip 60/10`, `🤖 Auto flip 60%`, `🤖 Auto flip off`
  - trade prompt: `Send the Auto flip % and optional step for trade #ID (e.g. 60 10 = flip at 60%, 70%, 80%…; 60 = once), or off.`
  - settings prompt: `Send the default Auto flip % and optional step for new bid_ask / mixed trades (e.g. 60 10 = flip at 60%, 70%, 80%…; 60 = once), or off.`

## Review Focus

- Crossed% lands exactly on a level (e.g. 70.0 with step 10) → next must be 80, not 70 again (Task 3 test `crossed exactly on a level moves to the next one`).
- Earlier flip leg partly above and partly below the active bin (manual Flip after a bounce) → only its token-side bins are taken (Task 1 test `flip leg bins on the SOL side are left`).
- Flip leg closed in state (trade partially closed) → ignored like any closed leg (Task 1 test `closed flip legs are ignored`).
- Settings file with a step but no start (`autoFlipPct: null, autoFlipStep: 10`) → `/open` gives no auto flip (Task 2 test `step without a start gives no auto flip`).
- Floating step math (start 33.3, step 3.3) → next stays strictly above crossed and is shown rounded (Task 3 test `fractional step stays above crossed`).

---

### Task 1: Flip re-shapes the whole token side

**Files:**
- Modify: `src/lp/flip-trade.js` (`planFlip`, selection lines ~146-151)
- Modify: `src/tg/positions.js` (`describeFlip` copy, confirm copy ~line 534)
- Test: `test/flip-trade.test.js`, `test/tg-positions.test.js`

**Interfaces:**
- Produces: `planFlip(trade, { deps })` — same return shape; `legs` may now include flip-leg addresses. `selectFlipBins` signature unchanged.

Rule: candidates = open legs (not closed in state, flip or not). If `selectFlipBins` over the **non-flip** candidate legs gives `binCount 0` → return `{ binCount: 0 }`. Otherwise select over **all** candidate legs (70 cap shared).

- [ ] **Step 1: Write failing tests** in `test/flip-trade.test.js` (use existing `newTrade`, `fakeDeps`, `addTradeLeg`, `bins` helpers):
  - `second flip takes new bins and the earlier flip leg`: trade L1 + flip leg F (`addTradeLeg(id,"F",{flip:true})`); readLegs active 100, L1 token bins 101..105, F bins 106..120 → `plan.binCount === 20`, `plan.legs` deep-equals `[{position:"L1",fromBinId:101,toBinId:105},{position:"F",fromBinId:106,toBinId:120}]`, `plan.newRange` `{minBinId:101,maxBinId:120}`.
  - `flipTrade withdraws from both legs and opens one position`: same setup → `calls.removeBins` has 2 entries (L1, F), `calls.open.length === 1`, `getTrade(id).positions` = `["L1","F","NewPos"]`, `flipLegs` = `["F","NewPos"]`.
  - `flip leg bins on the SOL side are left`: active 100, L1 bins 101..102, F bins `[...bins(95, 100), ...bins(103, 110)]` (all tokenAmount 1) → `plan.legs` deep-equals `[{position:"L1",fromBinId:101,toBinId:102},{position:"F",fromBinId:103,toBinId:110}]`, `binCount 10`.
  - `closed flip legs are ignored`: F recorded closed (`recordClose("F",...)`) with bins 106..120, L1 101..105 → `plan.binCount === 5`.
  - `the 70-bin cap is shared with flip legs`: L1 101..110, F 111..200 → `binCount 70`, F range `111..170`.
  - Keep existing `planFlip does not re-flip flip legs` unchanged (must still pass).
- [ ] **Step 2: Update copy tests** in `test/tg-positions.test.js` lines 667, 704, 725 to the Global Constraints copy (`one token position` / `one position`).
- [ ] **Step 3: Run** `node --test test/flip-trade.test.js test/tg-positions.test.js` — Expected: the new/changed tests FAIL.
- [ ] **Step 4: Implement** the rule in `planFlip` and the three copy strings in `src/tg/positions.js`. Update the comment above the selection.
- [ ] **Step 5: Run** `npm test` — Expected: all PASS.
- [ ] **Step 6: Commit** `feat(flip): re-shape the whole token side into one position`

---

### Task 2: Optional step — parser, settings default, /open, Telegram

**Files:**
- Modify: `src/tg/parse.js` (`parseAutoFlipInput`)
- Modify: `src/state/settings.js` (`DEFAULT_SETTINGS.autoFlipStep`, `withDefaults`, `setAutoFlipDefault`)
- Modify: `src/lp/open-trade.js` (`autoFlipForNewTrade`)
- Modify: `src/tg/positions.js` (label, prompt, `pos-autoflip` handler)
- Modify: `src/tg/settings.js` (label, prompt, `settings-autoflip` handler)
- Test: `test/tg-parse.test.js`, `test/settings.test.js`, `test/open-trade.test.js`, `test/tg-positions.test.js`, `test/tg-settings.test.js`

**Interfaces:**
- Produces:
  - `parseAutoFlipInput(text)` → `{ on: false }` | `{ on: true, pct }` | `{ on: true, pct, step }` | `null`
  - `setAutoFlipDefault(pct, step = null)` — throws if `pct` invalid (non-null) or `step` non-null and not 1–99, or `step` non-null with `pct` null. Stores `autoFlipPct`, `autoFlipStep`.
  - `getSettings().autoFlipStep` — `null` default; invalid file value → `null`.
  - `trade.autoFlip` shape `{ pct }` or `{ pct, step }` (key `step` absent when none).
  - Shared label helper `autoFlipLabel(autoFlip)` exported from `src/tg/format.js`: `{pct:60,step:10}` → `"🤖 Auto flip 60/10"`, `{pct:60}` → `"🤖 Auto flip 60%"`, null → `"🤖 Auto flip off"`.

- [ ] **Step 1: Write failing tests**
  - parse: `"60 10"` → `{on:true,pct:60,step:10}`; `"60% 10"` → same; `"60"` → `{on:true,pct:60}` (no `step` key); invalid → null for `"60 0"`, `"60 100"`, `"60 10 5"`, `"0 10"`, `"60 x"`.
  - settings: `setAutoFlipDefault(60, 10)` → `autoFlipPct 60, autoFlipStep 10`; `setAutoFlipDefault(null)` → both null; throws for `(60, 0)`, `(60, 100)`, `(null, 10)`; `step without a start gives no auto flip`: file `{ autoFlipPct: null, autoFlipStep: 10 }` → `getSettings().autoFlipStep === null`; file `{ autoFlipPct: 60, autoFlipStep: 250 }` → step null.
  - open-trade: default `(60, 10)` → bid_ask trade `autoFlip` deep-equals `{pct:60,step:10}`; default `(60)` → `{pct:60}`.
  - format: `autoFlipLabel` three cases above.
  - tg-positions: label `🤖 Auto flip 60/10` for `autoFlip {pct:60,step:10}`; prompt text = Global Constraints trade prompt; sending `60 10` sets `{pct:60,step:10}`; update existing assertions at lines 733 (prompt text).
  - tg-settings: prompt text = settings prompt; `60 10` → settings `60/10` and keyboard has `🤖 Auto flip 60/10`; update existing assertion at line 250.
- [ ] **Step 2: Run** `node --test test/tg-parse.test.js test/settings.test.js test/open-trade.test.js test/tg-format.test.js test/tg-positions.test.js test/tg-settings.test.js` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Both Telegram handlers store `parsed.step` only when present (`{ pct, step }` vs `{ pct }`); `/settings` calls `setAutoFlipDefault(parsed.on ? parsed.pct : null, parsed.on ? parsed.step ?? null : null)`. Both screens use `autoFlipLabel`.
- [ ] **Step 4: Run** `npm test` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(tg): auto flip start and optional step`

---

### Task 3: Auto flip steps to the next threshold

**Files:**
- Modify: `src/exit/auto-flip.js` (`runAutoFlips`, `autoFlipMessage`, new export)
- Test: `test/auto-flip.test.js`

**Interfaces:**
- Consumes: `trade.autoFlip` `{ pct, step? }` (Task 2); `setTradeAutoFlip`.
- Produces:
  - `export function nextAutoFlipPct(pct, step, crossed): number | null` — null when no step or result > 100.
  - `autoFlipMessage(trade, pct, res, nextPct = null)` — tail per Global Constraints.

`nextAutoFlipPct`: `k = Math.floor((crossed - pct) / step) + 1`, `next = pct + k * step`; if `next <= crossed` (float edge) add `step`; `next > 100` → null.

- [ ] **Step 1: Write failing tests**
  - `nextAutoFlipPct`: `(60,10,60)` → 70; `(60,10,63)` → 70; `crossed exactly on a level moves to the next one`: `(60,10,70)` → 80; fast drop `(60,10,85)` → 90; `(60,10,95)` → null; `(60,undefined,65)` → null; `fractional step stays above crossed`: `(33.3,3.3,36.6)` result `> 36.6` and `≈ 39.9` (within 1e-9).
  - `runAutoFlips` with `autoFlip {pct:60,step:10}`:
    - at crossed 60 (positions active 40 with `rangeX`) success → `getTrade().autoFlip` deep-equals `{pct:70,step:10}`; message ends `Next auto flip at 70%.` and contains `→ one position over 30 bins.`
    - fast drop: active 15 (85%) → `{pct:90,step:10}`.
    - past 100: `{pct:100,step:10}` at active 0 → autoFlip removed; message ends `Auto flip turned off.`
    - dry run steps: dry-run result at 60% → `{pct:70,step:10}`, message `🧪 DRY RUN — auto flip #ID AAA-SOL at 60% crossed would flip 30 bins. Next auto flip at 70%.`
    - failure still off: error result → autoFlip removed, failure copy unchanged.
  - Update existing message assertions (lines 128, 218 and the dry-run test) to the new copy (`one position`, tail `Auto flip turned off.` on success without step).
- [ ] **Step 2: Run** `node --test test/auto-flip.test.js` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** `nextAutoFlipPct`; in `runAutoFlips` after success or dry run compute `next = nextAutoFlipPct(trade.autoFlip.pct, trade.autoFlip.step, pct)` → `setTradeAutoFlip(id, next == null ? null : { pct: next, step })`; failures keep `setTradeAutoFlip(id, null)`. Show `Q` via `Math.round(next * 10) / 10`.
- [ ] **Step 4: Run** `npm test && npx eslint src test` — Expected: all PASS, lint clean.
- [ ] **Step 5: Commit** `feat(exit): auto flip steps to the next threshold`
