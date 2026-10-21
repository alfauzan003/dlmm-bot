import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { parseStratText, loadStratSchema, typeOf, validateValue, RESTART_KEYS } from "../src/config/strat-schema.js";

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

test("parseStratText: comment block right under a header is the section description", () => {
  const s = parseStratText(
    [
      "# ===== Swap =====",
      "# Turning tokens into SOL.",
      "",
      "# Swap after close.",
      "AUTO_SWAP_AFTER_CLOSE=true",
      "",
      "# ===== Logs =====",
      "# Level help",
      "LOG_LEVEL=info",
    ].join("\n")
  );
  assert.equal(s.sections[0].description, "Turning tokens into SOL.");
  assert.equal(s.entries.AUTO_SWAP_AFTER_CLOSE.help, "Swap after close.");
  assert.equal(s.sections[1].description, "");
  assert.equal(s.entries.LOG_LEVEL.help, "Level help");
});

test("parseStratText: sections, help, defaults", () => {
  const s = parseStratText(TEXT);
  assert.deepEqual(
    s.sections.map((x) => x.title),
    ["General", "Entry", "Fee entry (priority fee / Jito tip)"]
  );
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
  assert.equal(typeOf("POOL_LIST_FILE", "pool.txt").type, "file");
  assert.equal(typeOf("JITO_BLOCK_ENGINE_URL", "https://x").type, "string");
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

test("committed strat.conf: every default validates and restart keys exist", () => {
  const schema = loadStratSchema(fileURLToPath(new URL("../strat.conf", import.meta.url)));
  const keys = Object.keys(schema.entries);
  assert.ok(keys.length >= 50, `only ${keys.length} keys`);
  for (const removed of ["TIMEFRAME", "TRAILING_CONFIRM_DELAY_SEC", "SPOT_FALLBACK_ENABLED", "SPOT_REENTRY_ENABLED"]) {
    assert.equal(schema.entries[removed], undefined, removed);
  }
  assert.equal(
    keys.some((k) => /^(BIDASK|SPOT)_/.test(k)),
    false
  );
  for (const section of schema.sections) assert.ok(section.description, `${section.title} has no description`);
  for (const key of keys) {
    const res = validateValue(key, schema.entries[key].default, schema);
    assert.equal(res.ok, true, `${key}: ${res.error}`);
  }
  for (const key of RESTART_KEYS) assert.ok(schema.entries[key], `${key} missing from strat.conf`);
});

test("Evil Panda keys live in their own section and reject bad values", () => {
  const schema = loadStratSchema(fileURLToPath(new URL("../strat.conf", import.meta.url)));
  const section = schema.sections.find((s) => s.title === "Exit strategy · Evil Panda");
  assert.ok(section, "Evil Panda section missing");
  assert.ok(section.keys.includes("EVIL_PANDA_RSI_LEVEL"));
  assert.equal(schema.entries.EVIL_PANDA_DEFAULT_ON.default, "false");
  const bad = {
    EVIL_PANDA_RSI_LEVEL: ["101", "-1"],
    EVIL_PANDA_RSI_LENGTH: ["1.5", "0"],
    EVIL_PANDA_BB_STDDEV: ["0"],
    EVIL_PANDA_BB_LENGTH: ["1"],
    EVIL_PANDA_ST_MULTIPLIER: ["0"],
    EVIL_PANDA_MACD_SLOW: ["0"],
  };
  for (const [key, values] of Object.entries(bad)) {
    for (const v of values) assert.equal(validateValue(key, v, schema).ok, false, `${key}=${v}`);
  }
  assert.equal(validateValue("EVIL_PANDA_RSI_LEVEL", "85", schema).ok, true);
  assert.deepEqual(validateValue("EVIL_PANDA_SIGNAL_MODE", "Close", schema), { ok: true, value: "close" });
  assert.equal(validateValue("EVIL_PANDA_SIGNAL_MODE", "fast", schema).ok, false);
  assert.equal(schema.entries.EVIL_PANDA_SIGNAL_MODE.default, "live");
  for (const key of section.keys) assert.equal(RESTART_KEYS.has(key), false, key);
});

test("auto entry profile keys: enums, ranges, whole numbers, restart key", () => {
  const s = parseStratText(
    [
      "# ===== Auto Entry · Degen profile =====",
      "DEGEN_ENTRY_TIMING=pullback",
      "DEGEN_MAX_POSITIONS=2",
      "DEGEN_FLIP_PCT=60",
      "DEGEN_RANGE_PCT=50",
      "DEGEN_MIN_HOLDERS=800",
      "AUTO_SCAN_INTERVAL_SEC=60",
    ].join("\n")
  );
  assert.deepEqual(typeOf("DEGEN_ENTRY_TIMING", "pullback"), { type: "enum", options: ["pullback", "immediate"] });
  assert.deepEqual(typeOf("MULTI_RANGE_MODE", "support"), { type: "enum", options: ["fixed", "support"] });
  assert.equal(validateValue("DEGEN_MAX_POSITIONS", "11", s).ok, false);
  assert.equal(validateValue("DEGEN_MAX_POSITIONS", "10", s).ok, true);
  assert.equal(validateValue("DEGEN_FLIP_PCT", "0", s).ok, false);
  assert.equal(validateValue("DEGEN_RANGE_PCT", "99.5", s).ok, false);
  assert.equal(validateValue("DEGEN_MIN_HOLDERS", "1.5", s).ok, false);
  assert.equal(validateValue("AUTO_SCAN_INTERVAL_SEC", "10", s).ok, false);
  assert.equal(RESTART_KEYS.has("AUTO_SCAN_INTERVAL_SEC"), true);
});

test("loadStratSchema on a missing file is empty", () => {
  assert.deepEqual(loadStratSchema("does-not-exist.conf"), { sections: [], entries: {} });
});

test("safety-relevant numbers reject one-typo values from a phone", () => {
  const schema = loadStratSchema(fileURLToPath(new URL("../strat.conf", import.meta.url)));
  const bad = {
    POLL_INTERVAL_HOLD: ["0", "-1"],
    POLL_INTERVAL_IDLE: ["0"],
    TG_STATUS_INTERVAL: ["0"],
    GAS_RESERVE: ["-5"],
    ST_ATR_PERIOD: ["0", "2.5"],
    ENTRY_DEFAULT_SIZE_SOL: ["0"],
    ENTRY_SIZE_SPLIT: ["1.5", "-0.1"],
    GMGN_MAX_STALE_MIN: ["0"],
    ENTRY_TX_RETRY_ATTEMPTS: ["1.5"],
  };
  for (const [key, values] of Object.entries(bad)) {
    for (const v of values) assert.equal(validateValue(key, v, schema).ok, false, `${key}=${v}`);
  }
  assert.equal(validateValue("POLL_INTERVAL_HOLD", "0.1", schema).ok, true);
  assert.equal(validateValue("ST_ATR_PERIOD", "14", schema).ok, true);
});

test("file keys accept only a bare, non-protected filename", () => {
  const schema = loadStratSchema(fileURLToPath(new URL("../strat.conf", import.meta.url)));
  for (const key of ["POOL_LIST_FILE", "SUPERTREND_CACHE_FILE"]) {
    for (const v of [
      ".env",
      "state.json",
      "wallet.key",
      "settings.json",
      "strat.conf",
      "../x.txt",
      "a/b.txt",
      "a\\b.txt",
    ]) {
      assert.equal(validateValue(key, v, schema).ok, false, `${key}=${v}`);
    }
    assert.equal(validateValue(key, "pools-2.txt", schema).ok, true, key);
  }
});
