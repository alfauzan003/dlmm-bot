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
const { getSettings, isOn, DEFAULT_SETTINGS } = await import("../src/state/settings.js");

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
  assert.ok(labels.includes("❌ DCA"));
  assert.ok(text.includes("DRY_RUN: on (.env)"));
});

test("buildSettings callback data", () => {
  const { keyboard } = buildSettings(DEFAULT_SETTINGS, false);
  const data = keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(data, [
    "set:toggle:autoExit",
    "set:toggle:autoEntry",
    "set:toggle:deterministicExit",
    "set:toggle:dca",
    "set:edit:tp",
    "set:edit:sl",
    "set:edit:trail",
  ]);
});

test("settings toggle button flips the setting", async () => {
  const { bot, calls } = build();
  assert.equal(isOn("dca"), false);
  await bot.handleUpdate(cbUpdate("set:toggle:dca"));
  assert.equal(isOn("dca"), true);
  assert.ok(calls.some((c) => c.method === "editMessageText"));
  await bot.handleUpdate(cbUpdate("set:toggle:dca"));
  assert.equal(isOn("dca"), false);
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
