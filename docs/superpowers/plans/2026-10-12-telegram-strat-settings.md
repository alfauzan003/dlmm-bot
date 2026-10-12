# Telegram Strat Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every key in `strat.conf` can be viewed and changed from Telegram (`/settings` → 🧩 Strategy), stored as per-instance overrides in `settings.json`, applied live except ⟳ keys.

**Architecture:** A pure schema module parses `strat.conf` (sections, help comments, inferred types + a small override table) and validates input. The env loader merges `settings.json.stratOverrides` on top of `strat.conf`; `config/index.js` becomes `buildConfig(e)` + `reloadConfig()` that refreshes the shared config object in place. `state/settings.js` stores overrides and triggers reload; a new grammY module renders the menu.

**Tech Stack:** Node 24 ESM, `node:test`, grammY `InlineKeyboard`, existing `src/tg/bot.js` helpers (`withGuard`, `registerPrompt`), `src/tg/session.js`.

**Spec:** `docs/superpowers/specs/2026-10-12-telegram-strat-settings-design.md`

## Global Constraints

- Precedence: `.env` < `strat.conf` < `settings.json.stratOverrides`.
- Only keys present in `strat.conf` are editable or read from `stratOverrides`; `.env`-only keys (incl. `DRY_RUN`) never appear.
- Overrides are stored as strings (`{ KEY: "value" }`) and parsed by the same `bool`/`num`/split code as `strat.conf`.
- `src/config/*` must not import `src/state/settings.js` (no config ↔ state cycle); the loader reads `SETTINGS_FILE` JSON directly.
- Invalid values are never written; failed `reloadConfig()` leaves the old config and the old file.
- Telegram callback data ≤ 64 bytes, prefix `st:`.
- AGENTS.md: minimal changes, tests use `STRAT_FILE` / `SETTINGS_FILE` / `STATE_FILE` overrides, new modules added to `MODULES` in `test/smoke.test.js`, never log secrets.
- Format with Prettier only the files you touch (`npx prettier --write <files>`), never the whole tree.

## Review Focus

1. **Production `settings.json` leaking into tests** — once a user saves overrides, every test that imports config without `SETTINGS_FILE` would read them. Expected: tests always see a temp/nonexistent settings file. → Task 2 adds `test/setup-env.js` + test.
2. **Other settings writes dropping overrides** — `setToggle`, `setExitDefaults`, presets rewrite `settings.json` through `withDefaults`. Expected: `stratOverrides` survive. → Task 3 test.
3. **`strat.conf` edited after an override was saved** (key removed or renamed). Expected: override ignored by the loader, stale Telegram button answers "no longer in strat.conf" without crashing. → Task 2 + Task 4 tests.
4. **Sloppy numeric input from a phone** (`" 10 "`, `"+5"`, `"0,5"`, `"abc"`, empty). Expected: whitespace/`+` accepted, comma and junk rejected with a message naming the expected type/range, prompt stays active. → Task 1 + Task 4 tests.
5. **Reload with tests' temporary config mutations** (`config.dryRun = false` in tests) — `reloadConfig()` must keep `dryRun` coming from `.env`, and nested objects keep identity. → Task 2 test.

---

### Task 1: `strat-schema.js` — parse, types, validation

**Files:**
- Create: `src/config/strat-schema.js`
- Create: `test/strat-schema.test.js`
- Modify: `test/smoke.test.js` (add `"../src/config/strat-schema.js"` to `MODULES`)

**Interfaces:**
- Produces:
  - `parseStratText(text: string) -> { sections: Array<{ title: string, keys: string[] }>, entries: Record<string, { key, default: string, help: string, section: number }> }`
  - `loadStratSchema(file = STRAT_FILE) -> same shape` (reads the file each call; missing file → `{ sections: [], entries: {} }`)
  - `typeOf(key: string, def: string) -> { type: "bool"|"number"|"enum"|"list"|"string", options?: string[], min?: number, max?: number }`
  - `validateValue(key: string, raw: string, schema) -> { ok: true, value: string } | { ok: false, error: string }`
  - `RESTART_KEYS: Set<string>`

- [ ] **Step 1: Write failing tests in `test/strat-schema.test.js`**

```js
const TEXT = [
  "# banner",
  "# =========",
  "SOL_MODE=false",
  "",
  "# ===== Entry =====",
  "# Ukuran split",
  "# token vs SOL",
  "ENTRY_SIZE_SPLIT=0.5",
  "ENTRY_SCAN_INTERVAL_SEC=15",
  "#OLD_KEY=1",
  "",
  "# ===== Fee entry (priority fee / Jito tip) =====",
  "ENTRY_FEE_MODE=none",
  "JITO_TIP_ACCOUNTS=",
  "POOL_LIST_FILE=pool.txt",
].join("\n");

test("parseStratText: sections, help, defaults", () => {
  const s = parseStratText(TEXT);
  assert.deepEqual(s.sections.map((x) => x.title), ["General", "Entry", "Fee entry (priority fee / Jito tip)"]);
  assert.deepEqual(s.sections[1].keys, ["ENTRY_SIZE_SPLIT", "ENTRY_SCAN_INTERVAL_SEC"]);
  assert.equal(s.entries.ENTRY_SIZE_SPLIT.help, "Ukuran split\ntoken vs SOL");
  assert.equal(s.entries.ENTRY_SCAN_INTERVAL_SEC.help, "");
  assert.equal(s.entries.ENTRY_SIZE_SPLIT.default, "0.5");
  assert.equal(s.entries.OLD_KEY, undefined);
  assert.equal(s.entries.SOL_MODE.section, 0);
});

test("typeOf infers and applies the override table", () => {
  assert.equal(typeOf("SOL_MODE", "false").type, "bool");
  assert.equal(typeOf("ENTRY_SCAN_INTERVAL_SEC", "15").type, "number");
  assert.deepEqual(typeOf("ENTRY_FEE_MODE", "none"), { type: "enum", options: ["none", "priority", "jito", "both"] });
  assert.equal(typeOf("JITO_TIP_ACCOUNTS", "").type, "list");
  assert.equal(typeOf("POOL_LIST_FILE", "pool.txt").type, "string");
  assert.deepEqual([typeOf("ENTRY_SIZE_SPLIT", "0.5").min, typeOf("ENTRY_SIZE_SPLIT", "0.5").max], [0, 1]);
});

test("validateValue accepts and normalizes good input", () => {
  const s = parseStratText(TEXT);
  assert.deepEqual(validateValue("ENTRY_SIZE_SPLIT", " +0.25 ", s), { ok: true, value: "0.25" });
  assert.deepEqual(validateValue("SOL_MODE", "TRUE", s), { ok: true, value: "true" });
  assert.deepEqual(validateValue("ENTRY_FEE_MODE", "Jito", s), { ok: true, value: "jito" });
  assert.deepEqual(validateValue("JITO_TIP_ACCOUNTS", " a, ,b ", s), { ok: true, value: "a,b" });
  assert.deepEqual(validateValue("JITO_TIP_ACCOUNTS", "-", s), { ok: true, value: "" });
});

test("validateValue rejects bad input with a reason", () => {
  const s = parseStratText(TEXT);
  for (const raw of ["0,5", "abc", "", "1.5"]) assert.equal(validateValue("ENTRY_SIZE_SPLIT", raw, s).ok, false, raw);
  assert.match(validateValue("ENTRY_SIZE_SPLIT", "1.5", s).error, /0.*1/);
  assert.equal(validateValue("ENTRY_SCAN_INTERVAL_SEC", "-1", s).ok, false);
  assert.equal(validateValue("SOL_MODE", "yes", s).ok, false);
  assert.equal(validateValue("ENTRY_FEE_MODE", "fast", s).ok, false);
  assert.equal(validateValue("POOL_LIST_FILE", "  ", s).ok, false);
  assert.equal(validateValue("NOT_A_KEY", "1", s).ok, false);
});
```

- [ ] **Step 2: Run `node --test test/strat-schema.test.js`** — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/config/strat-schema.js`**

Pinned values:
- Section header regex: `/^#\s*={5}\s+([^=].*?)\s+={5}\s*$/` (banner lines of only `=` do not match). Keys before the first header go to section 0 titled `"General"`.
- Key line regex: `/^([A-Z][A-Z0-9_]*)=(.*)$/` on the trimmed line; `#KEY=` lines are comments. Help = consecutive `#` comment lines directly above the key (strip leading `#` and one space), reset by blank lines, headers, and key lines.
- Inference: default `true`/`false` → bool; default matching `num()` (finite, non-empty) → number; else string.
- `OVERRIDES` table:
  - enum: `ENTRY_FEE_MODE` [none, priority, jito, both]; `LOG_LEVEL` [info, debug]; `CANDLE_15M_SOURCE` [gmgn, meteora]; `TIMEFRAME`, `VOLUME_TIMEFRAME`, `ENTRY_TIMEFRAME` [1m, 5m, 15m, 1h, 4h]; `ENTRY_TOUCH_MODE` [held_pullback, first_touch].
  - list: `SWEEP_EXCLUDE_MINTS`, `JITO_TIP_ACCOUNTS`.
  - min/max: `ENTRY_SIZE_SPLIT` 0–1; `TRADE_EXIT_INTERVAL_SEC` ≥1; `JUPITER_POLL_INTERVAL_SEC` ≥1; `ENTRY_SCAN_INTERVAL_SEC` ≥5; `ENTRY_TX_RESEND_INTERVAL_MS` ≥200; `ENTRY_TX_RETRY_ATTEMPTS` ≥1.
  - Generic rule for numbers without an explicit entry: keys ending `_SEC`, `_MS`, `_MINUTES`, `_DAYS`, `_HOURS`, `_COUNT`, `_ATTEMPTS`, `_PER_MIN`, `_RETRY`, `_MAX`, `_SOL`, `_BPS` → min 0.
- `RESTART_KEYS`: `TRADE_EXIT_INTERVAL_SEC`, `ENTRY_SCAN_INTERVAL_SEC`, `JUPITER_POLL_INTERVAL_SEC`, `LOG_LEVEL`, `LOG_RETENTION_DAYS`, `METEORA_MAX_PER_MIN`, `GMGN_MAX_PER_MIN`, `GMGN_MIN_GAP_SEC` (all read once at start: `src/index.js`, `src/entry/index.js` `setInterval`, `src/core/logger.js`, `src/market/candles.js`, `src/market/gmgn-limiter.js` module level).
- Validation: trim; number = `/^[+-]?\d+(\.\d+)?$/` then bounds, value normalized via `String(Number(x))`; bool case-insensitive true/false → lowercase; enum case-insensitive → canonical option; list: `-` or empty → `""`, else split `,`, trim, drop empties, join `,`; string: non-empty after trim. Unknown key → `{ ok: false, error: "KEY is not in strat.conf" }`. Error messages name the type and bounds, e.g. `"ENTRY_SIZE_SPLIT must be a number between 0 and 1"`, `"SOL_MODE must be true or false"`, `"ENTRY_FEE_MODE must be one of: none, priority, jito, both"`.

- [ ] **Step 4: Run `node --test test/strat-schema.test.js test/smoke.test.js`** — Expected: PASS.

- [ ] **Step 5: Add a real-file test** to `test/strat-schema.test.js`: `loadStratSchema(new URL("../strat.conf", import.meta.url).pathname …)` (use `fileURLToPath`) has ≥ 120 entries, every key's own default passes `validateValue(key, def, schema)` (catches table mistakes against the committed file), and every `RESTART_KEYS` member exists in it. Run → PASS.

- [ ] **Step 6: Commit** `feat(config): strat.conf schema parser and validation`

---

### Task 2: Loader overrides + `buildConfig` / `reloadConfig`

**Files:**
- Modify: `src/config/env.js` (`loadEnv`)
- Modify: `src/config/index.js` (wrap body in `buildConfig`, add `reloadConfig`)
- Create: `test/setup-env.js`
- Modify: `package.json` (`"test": "node --test --import ./test/setup-env.js"`)
- Modify: `test/env-loader.test.js`
- Create: `test/config-reload.test.js`
- Create: `test/setup-env.test.js`

**Interfaces:**
- Consumes: none from Task 1 (loader filters by keys parsed with the existing `parseEnvFile`).
- Produces:
  - `loadEnv(stratFile = STRAT_FILE, envFile = ENV_FILE, settingsFile = SETTINGS_FILE) -> Record<string,string>` = `{ ...env, ...strat, ...overrides }` where overrides = string-valued entries of `settings.stratOverrides` whose key exists in strat. Unreadable/corrupt settings file → no overrides.
  - `buildConfig(e: Record<string,string>) -> config object` (named export from `src/config/index.js`)
  - `reloadConfig() -> config` (named export): `buildConfig(loadEnv())`, then deep-assign into the existing default-export object (plain nested objects updated in place, arrays/functions/primitives replaced). Throws if `buildConfig` throws, before touching `config`.

- [ ] **Step 1: Write failing tests**

`test/env-loader.test.js` additions:
```js
test("stratOverrides menang atas strat.conf, hanya untuk key yang ada di strat.conf", () => {
  const strat = write("o.conf", "A=1\nB=2\n");
  const env = write("o.env", "A=0\nSECRET=s\n");
  const settings = write("o.json", JSON.stringify({ stratOverrides: { A: "9", SECRET: "x", GONE: "1", B: 5 } }));
  const cfg = loadEnv(strat, env, settings);
  assert.equal(cfg.A, "9");
  assert.equal(cfg.B, "2"); // non-string ignored
  assert.equal(cfg.SECRET, "s"); // .env-only key not overridable
  assert.equal(cfg.GONE, undefined);
});

test("settings.json rusak atau tidak ada = tanpa override", () => {
  const strat = write("p.conf", "A=1\n");
  assert.equal(loadEnv(strat, write("p.env", ""), write("p.json", "{oops")).A, "1");
  assert.equal(loadEnv(strat, write("q.env", ""), path.join(TMP, "none.json")).A, "1");
});
```

`test/setup-env.test.js` (does NOT set `SETTINGS_FILE` itself):
```js
test("npm test points SETTINGS_FILE away from the production settings.json", () => {
  assert.ok(process.env.SETTINGS_FILE);
  assert.notEqual(path.resolve(process.env.SETTINGS_FILE), path.resolve(ROOT, "settings.json"));
});
```

`test/config-reload.test.js` (sets `STRAT_FILE` to a temp copy of `strat.conf` and `SETTINGS_FILE` to a temp file before importing config):
```js
test("reloadConfig applies overrides in place and keeps nested identity", () => {
  const baselineMode = buildConfig(loadEnv()).entry.fees.mode;
  const fees = config.entry.fees;
  const spot = config.spot;
  fs.writeFileSync(SETTINGS, JSON.stringify({ stratOverrides: { ENTRY_FEE_MODE: "both", SPOT_TRAILING_TRIGGER_PCT: "33", ENTRY_SIZE_SPLIT: "0.3" } }));
  reloadConfig();
  assert.equal(config.entry.fees, fees);
  assert.equal(config.spot, spot);
  assert.equal(config.entry.fees.mode, "both");
  assert.equal(config.rulesFor("spot").trailingTriggerPct, 33);
  assert.equal(config.entry.sizeSplit, 0.3);
  fs.writeFileSync(SETTINGS, "{}");
  reloadConfig();
  assert.equal(config.entry.fees.mode, baselineMode);
});

test("reloadConfig restores dryRun from .env even after a test mutated it", () => {
  const before = config.dryRun;
  config.dryRun = !before;
  reloadConfig();
  assert.equal(config.dryRun, before);
});
```

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/env-loader.test.js test/config-reload.test.js test/setup-env.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement**
  - `test/setup-env.js`: if `process.env.SETTINGS_FILE` is unset, set it to `path.join(os.tmpdir(), \`meteorabot-test-settings-${process.pid}.json\`)` (file not created). Do the same for nothing else.
  - `env.js` `loadEnv` per Interfaces; import `SETTINGS_FILE` from `../core/paths.js`.
  - `index.js`: move `const e = loadEnv()` and every section object into `export function buildConfig(e)`; `const config = buildConfig(loadEnv()); export default config;` keep `BINS_BELOW`, `BINS_ABOVE`, `STRATEGY` exports unchanged. `reloadConfig` per Interfaces with a local `assignDeep(target, source)`.

- [ ] **Step 4: Run** `npm test` — Expected: all pass (existing count + new).

- [ ] **Step 5: Commit** `feat(config): settings.json strat overrides and live reload`

---

### Task 3: Override storage in `state/settings.js`

**Files:**
- Modify: `src/state/settings.js`
- Modify: `test/settings.test.js`

**Interfaces:**
- Consumes: `validateValue`, `loadStratSchema` (Task 1); `reloadConfig` (Task 2).
- Produces:
  - `getStratOverrides() -> Record<string,string>`
  - `setStratOverride(key: string, raw: string) -> { ok: true, value: string, previous: string|null } | { ok: false, error: string }` — validates against `loadStratSchema()`, writes, calls `reloadConfig()`; on reload throw restores the previous settings file and returns `{ ok: false, error }`. Logs `log.info(\`Strat override ${key}: ${previous ?? "(default)"} → ${value}\`)`.
  - `clearStratOverride(key: string) -> void`, `clearStratOverrides() -> void` — write then `reloadConfig()`.
  - `DEFAULT_SETTINGS.stratOverrides = {}`; `withDefaults` keeps only string→string entries.

- [ ] **Step 1: Write failing tests** in `test/settings.test.js` (set `STRAT_FILE` to a temp file with `ENTRY_SIZE_SPLIT=0.5\nSOL_MODE=false\n` before import):

```js
test("setStratOverride validates, stores, and reloads config", async () => {
  const { default: config } = await import("../src/config/index.js");
  assert.deepEqual(setStratOverride("ENTRY_SIZE_SPLIT", "2"), { ok: false, error: "ENTRY_SIZE_SPLIT must be a number between 0 and 1" });
  assert.deepEqual(getStratOverrides(), {});
  assert.deepEqual(setStratOverride("ENTRY_SIZE_SPLIT", "0.3"), { ok: true, value: "0.3", previous: null });
  assert.equal(config.entry.sizeSplit, 0.3);
  assert.equal(JSON.parse(fs.readFileSync(FILE, "utf8")).stratOverrides.ENTRY_SIZE_SPLIT, "0.3");
  clearStratOverride("ENTRY_SIZE_SPLIT");
  assert.equal(config.entry.sizeSplit, 0.5);
});

test("other settings writes keep stratOverrides", () => {
  setStratOverride("SOL_MODE", "true");
  setToggle("autoEntry", true);
  setExitDefaults({ tpPct: 20 });
  setDepositPresets([1, 2, 3, 4]);
  assert.deepEqual(getStratOverrides(), { SOL_MODE: "true" });
  clearStratOverrides();
  assert.deepEqual(getStratOverrides(), {});
});

test("withDefaults drops malformed stratOverrides", () => {
  fs.writeFileSync(FILE, JSON.stringify({ stratOverrides: { A: "1", B: 2, C: null } }));
  assert.deepEqual(getSettings().stratOverrides, { A: "1" });
  fs.writeFileSync(FILE, JSON.stringify({ stratOverrides: ["x"] }));
  assert.deepEqual(getSettings().stratOverrides, {});
});
```
Update the existing `"first read creates defaults"` expectation if it deep-equals `DEFAULT_SETTINGS` (it will include `stratOverrides: {}` automatically).

- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/settings.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces (import `log` from `../core/logger.js`).
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): store strat.conf overrides`

---

### Task 4: Telegram 🧩 Strategy menu

**Files:**
- Create: `src/tg/strat-settings.js`
- Modify: `src/tg/settings.js` (add button `🧩 Strategy` → `st:home` on its own row after Auto flip; register the new module's handlers from `register(bot)` by calling `registerStrat(bot)` so `src/index.js` module list stays unchanged)
- Create: `test/tg-strat-settings.test.js`
- Modify: `test/tg-settings.test.js` (callback data list gains `"st:home"` last)
- Modify: `test/smoke.test.js` (`"../src/tg/strat-settings.js"`)
- Modify: `README.md` (Settings section: one paragraph on 🧩 Strategy, overrides in `settings.json`, ⟳ = restart), `AGENTS.md` (Jebakan: precedence `.env` < `strat.conf` < `settings.json.stratOverrides`; tuning from Telegram lives in `settings.json`, not git)

**Interfaces:**
- Consumes: `loadStratSchema`, `typeOf`, `RESTART_KEYS` (Task 1); `getStratOverrides`, `setStratOverride`, `clearStratOverride`, `clearStratOverrides` (Task 3); effective value = `loadEnv()[key]` (Task 2).
- Produces:
  - `buildStratHome(schema, overrides) -> { text, keyboard }`
  - `buildStratSection(schema, overrides, sectionIndex: number, page: number) -> { text, keyboard }` (8 keys per page)
  - `buildStratKey(schema, overrides, key: string) -> { text, keyboard }`
  - `registerStrat(bot) -> void`

Callback data:
`st:home` · `st:s:<i>:<page>` · `st:k:<KEY>` · `st:set:<KEY>:<value>` (bool/enum) · `st:edit:<KEY>` · `st:reset:<KEY>` · `st:resetall` → confirm screen with `st:resetall:yes` · back from home → existing `set:back`.

Card copy (HTML, values escaped with `esc`):
```
🧩 <b>KEY</b>
Value: <code>v</code>  (✏️ override | default)
Default (strat.conf): <code>d</code>
<help text>
⟳ Applies after restart        ← only for RESTART_KEYS
```
Section list button label: `KEY = value` with suffix ` ✏️` when overridden, ` ⟳` when restart key (truncate value to 16 chars). Home lists each section as `Title (n ✏️)` when it has n overrides.
Edit prompt text: number → `Send a new value for KEY (number between min and max)` (omit missing bound); list → `Send comma-separated values for KEY, or - for empty`; string → `Send a new value for KEY`. Prompt kind `strat-edit` with `{ key }`; invalid input replies the validation error and keeps the prompt; valid input clears the prompt and replies the card. Saved restart key adds `Saved — applies after restart.` above the card.
Stale key (not in schema): reply `KEY is no longer in strat.conf.` + its stored override is cleared if present.

- [ ] **Step 1: Write failing tests** in `test/tg-strat-settings.test.js` using the bot harness pattern from `test/tg-settings.test.js` (`createBot`, `cbUpdate`, `textUpdate`, API call capture); temp `STRAT_FILE` with two sections (`SOL_MODE=false`; `# ===== Entry =====` + 10 number keys incl. `ENTRY_SIZE_SPLIT=0.5` and `TRADE_EXIT_INTERVAL_SEC=1`; `ENTRY_FEE_MODE=none`), temp `SETTINGS_FILE`, `STATE_FILE`:
  - `st:home` lists both sections; `/settings` keyboard contains `st:home`.
  - Section 1 page 0 shows 8 key buttons and `st:s:1:1`; page 1 shows the rest and `st:s:1:0`.
  - `st:set:SOL_MODE:true` stores `"true"`, card shows `✏️ override`; `st:reset:SOL_MODE` clears it.
  - `st:set:ENTRY_FEE_MODE:jito` stores `"jito"`; `st:set:ENTRY_FEE_MODE:fast` stores nothing.
  - `st:edit:ENTRY_SIZE_SPLIT` then text `0,5` → reply contains `must be a number between 0 and 1`, prompt still `strat-edit`; then text `0.3` → stored `"0.3"`, prompt cleared.
  - Edit `TRADE_EXIT_INTERVAL_SEC` to `2` → reply contains `applies after restart`; section label has ` ⟳`.
  - `st:resetall` → confirm; `st:resetall:yes` → `getStratOverrides()` is `{}`.
  - `st:k:GONE_KEY` → reply `GONE_KEY is no longer in strat.conf.`, no throw.
  - Every callback_data produced on all screens is ≤ 64 bytes (walk home → each section → each key).
- [ ] **Step 2: Run** `node --test --import ./test/setup-env.js test/tg-strat-settings.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/tg/strat-settings.js` + the `/settings` button and `registerStrat(bot)` call; update `test/tg-settings.test.js` and `test/smoke.test.js`; update README.md and AGENTS.md.
- [ ] **Step 4: Run** `npm test` and `npm run lint` — Expected: all pass, no lint output beyond npm notices.
- [ ] **Step 5: Commit** `feat(tg): edit every strat.conf setting from /settings`
