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

test("committed strat.conf: every default validates and restart keys exist", () => {
  const schema = loadStratSchema(fileURLToPath(new URL("../strat.conf", import.meta.url)));
  const keys = Object.keys(schema.entries);
  assert.ok(keys.length >= 120, `only ${keys.length} keys`);
  for (const key of keys) {
    const res = validateValue(key, schema.entries[key].default, schema);
    assert.equal(res.ok, true, `${key}: ${res.error}`);
  }
  for (const key of RESTART_KEYS) assert.ok(schema.entries[key], `${key} missing from strat.conf`);
});

test("loadStratSchema on a missing file is empty", () => {
  assert.deepEqual(loadStratSchema("does-not-exist.conf"), { sections: [], entries: {} });
});
