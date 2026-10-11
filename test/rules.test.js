import test from "node:test";
import assert from "node:assert/strict";
import { modeRules, LEGACY_MODE, RULE_DEFAULTS } from "../src/config/rules.js";

test("modeRules falls back to defaults when env is empty", () => {
  const rules = modeRules({}, "FOO");
  assert.equal(rules.enableStopLoss, RULE_DEFAULTS.enableStopLoss);
  assert.equal(rules.trailingDropRatioPct, RULE_DEFAULTS.trailingDropRatioPct);
  assert.equal(rules.trailingDropPct, RULE_DEFAULTS.trailingDropPct);
  assert.equal(rules.exitWarmupMinutes, RULE_DEFAULTS.exitWarmupMinutes);
});

test("modeRules applies prefixed overrides", () => {
  const rules = modeRules({ FOO_ENABLE_STOP_LOSS: "true", FOO_STOP_LOSS_PCT: "-50" }, "FOO");
  assert.equal(rules.enableStopLoss, true);
  assert.equal(rules.stopLossPct, -50);
});

test("modeRules membaca EXIT_WARMUP_MINUTES dan menolak nilai negatif", () => {
  assert.equal(modeRules({ FOO_EXIT_WARMUP_MINUTES: "30" }, "FOO").exitWarmupMinutes, 30);
  assert.equal(modeRules({ FOO_EXIT_WARMUP_MINUTES: "-5" }, "FOO").exitWarmupMinutes, 0);
});

test("modeRules supports per-mode overrides", () => {
  const rules = modeRules({}, "FOO", { trailingTakeProfit: true, trailingTriggerPct: 15 });
  assert.equal(rules.trailingTakeProfit, true);
  assert.equal(rules.trailingTriggerPct, 15);
});

test("LEGACY_MODE maps legacy mode names", () => {
  assert.equal(LEGACY_MODE.bidask, "bidask:double");
  assert.equal(LEGACY_MODE["token-only"], "bidask:token");
  assert.equal(LEGACY_MODE["sol-only"], "bidask:sol");
});
