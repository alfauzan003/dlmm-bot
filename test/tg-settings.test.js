import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// File settings diarahkan ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tg-settings-"));
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { createBot } = await import("../src/tg/bot.js");
const settingsModule = await import("../src/tg/settings.js");
const session = await import("../src/tg/session.js");
const { parseStratText } = await import("../src/config/strat-schema.js");
const { getSettings, isOn, DEFAULT_SETTINGS, getRangePresets, getDepositPresets } =
  await import("../src/state/settings.js");

const { buildSettings } = settingsModule;
const OWNER = 123;
const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Test",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

test.beforeEach(() => {
  fs.rmSync(process.env.SETTINGS_FILE, { force: true });
  session.del("prompt");
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function build() {
  const bot = createBot({ token: "123:dummy", chatId: String(OWNER), modules: [settingsModule] });
  const calls = [];
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" } } };
  });
  bot.botInfo = BOT_INFO;
  return { bot, calls };
}

const cbUpdate = (data) => ({
  update_id: 2,
  callback_query: {
    id: "q1",
    from: { id: OWNER, is_bot: false, first_name: "U" },
    chat_instance: "c",
    data,
    message: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" }, text: "hi" },
  },
});

const textUpdate = (text) => ({
  update_id: 3,
  message: {
    message_id: 5,
    date: 1,
    chat: { id: OWNER, type: "private", first_name: "U" },
    from: { id: OWNER, is_bot: false, first_name: "U" },
    text,
  },
});

test("buildSettings labels", () => {
  const { text, keyboard } = buildSettings(DEFAULT_SETTINGS, true);
  const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes("🎯 TP 15"));
  assert.ok(labels.includes("🛑 SL 25"));
  assert.ok(labels.includes("📈 Trail 5 / 3"));
  assert.ok(labels.includes("✅ Auto Exit"));
  assert.ok(labels.includes("❌ Auto Entry"));
  assert.ok(!labels.some((l) => l.includes("Deterministic")));
  assert.ok(!labels.some((l) => l.includes("DCA")));
  assert.ok(labels.includes("🤖 Auto flip off"));
  assert.ok(text.includes("DRY_RUN: on (.env)"));
});

test("buildSettings callback data", () => {
  const { keyboard } = buildSettings(DEFAULT_SETTINGS, false);
  const data = keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(data, [
    "set:toggle:autoExit",
    "set:toggle:autoEntry",
    "set:edit:tp",
    "set:edit:sl",
    "set:edit:trail",
    "set:rng",
    "set:dep",
    "set:autoflip",
    "set:exit",
    "st:home",
  ]);
});

test("settings toggle button flips the setting", async () => {
  const { bot, calls } = build();
  assert.equal(isOn("autoEntry"), false);
  await bot.handleUpdate(cbUpdate("set:toggle:autoEntry"));
  assert.equal(isOn("autoEntry"), true);
  assert.ok(calls.some((c) => c.method === "editMessageText"));
  await bot.handleUpdate(cbUpdate("set:toggle:autoEntry"));
  assert.equal(isOn("autoEntry"), false);
});

test("set:edit stores a prompt and asks for a value", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("set:edit:tp"));
  assert.deepEqual(session.get("prompt"), { kind: "settings-exit", field: "tp" });
  assert.ok(calls.some((c) => c.method === "sendMessage"));
});

test("prompt answer updates TP and clears the prompt", async () => {
  const { bot, calls } = build();
  session.put("prompt", { kind: "settings-exit", field: "tp" });
  await bot.handleUpdate(textUpdate("20"));
  assert.equal(getSettings().exitDefaults.tpPct, 20);
  assert.equal(session.get("prompt"), null);
  assert.ok(calls.some((c) => c.method === "sendMessage"));
});

test("prompt answer for trail takes two numbers", async () => {
  const { bot } = build();
  session.put("prompt", { kind: "settings-exit", field: "trail" });
  await bot.handleUpdate(textUpdate("8 2.5"));
  const d = getSettings().exitDefaults;
  assert.equal(d.trailStartPct, 8);
  assert.equal(d.trailDistancePct, 2.5);
});

test("invalid prompt answer keeps the prompt and changes nothing", async () => {
  const { bot, calls } = build();
  session.put("prompt", { kind: "settings-exit", field: "sl" });
  await bot.handleUpdate(textUpdate("abc"));
  await bot.handleUpdate(textUpdate("off"));
  await bot.handleUpdate(textUpdate("0"));
  assert.deepEqual(session.get("prompt"), { kind: "settings-exit", field: "sl" });
  assert.equal(getSettings().exitDefaults.slPct, 25);
  const replies = calls.filter((c) => c.method === "sendMessage");
  assert.equal(replies.length, 3);
  assert.ok(replies.every((c) => c.payload.text === "Invalid value, try again"));
});

test("a signed SL answer is accepted as a plain percentage", async () => {
  const { bot } = build();
  session.put("prompt", { kind: "settings-exit", field: "sl" });
  await bot.handleUpdate(textUpdate("-30"));
  assert.equal(getSettings().exitDefaults.slPct, 30);
  assert.equal(session.get("prompt"), null);
});

test("text without a settings prompt does not change the defaults", async () => {
  const { bot } = build();
  await bot.handleUpdate(textUpdate("20"));
  assert.equal(getSettings().exitDefaults.tpPct, 15);
});

const lastKeyboard = (calls) =>
  [...calls]
    .reverse()
    .find((c) => c.payload.reply_markup)
    ?.payload.reply_markup.inline_keyboard.flat() ?? [];
const lastText = (calls) => [...calls].reverse().find((c) => c.payload.text)?.payload.text;

test("buildSettings shows the deposit presets", () => {
  const { keyboard } = buildSettings(DEFAULT_SETTINGS, false);
  const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes("📐 Range presets"));
  assert.ok(labels.includes("💰 Deposits 0.5 / 0.7 / 0.9 / 1"));
});

test("range presets screen lists presets with their ranges", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("set:rng"));
  const kb = lastKeyboard(calls);
  assert.ok(kb.some((b) => b.text === "Narrow (−20%/+20%)" && b.callback_data === "set:rng:narrow"));
  assert.ok(kb.some((b) => b.text === "Wide SOL (−65%)" && b.callback_data === "set:rng:wide_sol"));
  assert.ok(kb.some((b) => b.callback_data === "set:rng:reset"));
  assert.ok(kb.some((b) => b.callback_data === "set:back"));
});

test("editing a two-sided range preset takes two numbers", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("set:rng:narrow"));
  assert.deepEqual(session.get("prompt"), { kind: "settings-range", key: "narrow" });
  await bot.handleUpdate(textUpdate("30"));
  assert.equal(lastText(calls), "Invalid value, try again");
  assert.equal(getRangePresets()[0].below, 20);
  await bot.handleUpdate(textUpdate("15 25"));
  assert.deepEqual(getRangePresets()[0], { key: "narrow", label: "Narrow", below: 15, above: 25 });
  assert.equal(session.get("prompt"), null);
  assert.ok(lastKeyboard(calls).some((b) => b.text === "Narrow (−15%/+25%)"));
});

test("editing a SOL range preset takes one number", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("set:rng:narrow_sol"));
  await bot.handleUpdate(textUpdate("20 5"));
  assert.equal(lastText(calls), "Invalid value, try again");
  await bot.handleUpdate(textUpdate("100"));
  assert.equal(lastText(calls), "Invalid value, try again");
  await bot.handleUpdate(textUpdate("30"));
  assert.deepEqual(getRangePresets()[3], { key: "narrow_sol", label: "Narrow SOL", below: 30, above: 0 });
});

test("range presets reset to defaults", async () => {
  const { bot } = build();
  await bot.handleUpdate(cbUpdate("set:rng:wide"));
  await bot.handleUpdate(textUpdate("80 90"));
  assert.equal(getRangePresets()[2].below, 80);
  await bot.handleUpdate(cbUpdate("set:rng:reset"));
  assert.deepEqual(getRangePresets()[2], { key: "wide", label: "Wide", below: 65, above: 65 });
});

test("deposit presets screen edits and resets the four amounts", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("set:dep"));
  const kb = lastKeyboard(calls).map((b) => b.callback_data);
  assert.deepEqual(kb, ["set:dep:edit", "set:dep:reset", "set:back"]);
  await bot.handleUpdate(cbUpdate("set:dep:edit"));
  assert.deepEqual(session.get("prompt"), { kind: "settings-deposits" });
  await bot.handleUpdate(textUpdate("0.3 0.5"));
  assert.equal(lastText(calls), "Invalid value, try again");
  await bot.handleUpdate(textUpdate("0,3 0.5 1 2"));
  assert.deepEqual(getDepositPresets(), [0.3, 0.5, 1, 2]);
  assert.equal(session.get("prompt"), null);
  await bot.handleUpdate(cbUpdate("set:dep:reset"));
  assert.deepEqual(getDepositPresets(), [0.5, 0.7, 0.9, 1]);
});

test("back returns to the main settings screen", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("set:back"));
  assert.ok(lastText(calls).startsWith("⚙️ Settings"));
});

test("auto flip default: prompt sets, shows and clears it", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("set:autoflip"));
  assert.deepEqual(session.get("prompt"), { kind: "settings-autoflip" });
  assert.equal(lastText(calls), "Send the default Auto flip % for new bid_ask / mixed trades (e.g. 30), or off.");
  await bot.handleUpdate(textUpdate("abc"));
  assert.equal(lastText(calls), "Invalid value, try again");
  await bot.handleUpdate(textUpdate("30"));
  assert.equal(getSettings().autoFlipPct, 30);
  assert.equal(session.get("prompt"), null);
  assert.ok(lastKeyboard(calls).some((b) => b.text === "🤖 Auto flip 30%"));
  await bot.handleUpdate(cbUpdate("set:autoflip"));
  await bot.handleUpdate(textUpdate("off"));
  assert.equal(getSettings().autoFlipPct, null);
});

test("Exit strategy screen links Evil Panda to its strat.conf section", () => {
  const schema = parseStratText(
    [
      "SOL_MODE=false",
      "",
      "# ===== Exit strategy · Evil Panda =====",
      "# about",
      "",
      "EVIL_PANDA_DEFAULT_ON=false",
    ].join("\n")
  );
  const { text, keyboard } = settingsModule.buildExitStrategies(schema, { pandaDefaultOn: true });
  const kb = keyboard.inline_keyboard.flat();
  assert.deepEqual(
    kb.map((b) => [b.text, b.callback_data]),
    [
      ["🐼 Evil Panda (new trades: on)", "st:s:1:0"],
      ["◀ Back", "set:back"],
    ]
  );
  assert.match(text, /Exit strategy/);
  const none = settingsModule.buildExitStrategies(parseStratText("SOL_MODE=false"), { pandaDefaultOn: false });
  assert.deepEqual(
    none.keyboard.inline_keyboard.flat().map((b) => b.callback_data),
    ["set:back"]
  );
});

test("set:exit opens the Exit strategy screen", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("set:exit"));
  const edit = calls.filter((c) => c.method === "editMessageText").at(-1);
  assert.match(edit.payload.text, /Exit strategy/);
});
