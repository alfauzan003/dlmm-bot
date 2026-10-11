import test from "node:test";
import assert from "node:assert/strict";
import { createBot, withGuard, COMMANDS } from "../src/tg/bot.js";

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

function startUpdate(chatId, text = "/start") {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "private", first_name: "U" },
      from: { id: chatId, is_bot: false, first_name: "U" },
      text,
      entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.length }] : undefined,
    },
  };
}

// Bot tanpa jaringan: getMe dilewati (botInfo), semua panggilan API ditangkap.
function build(modules) {
  const bot = createBot({ token: "123:dummy", chatId: String(OWNER), modules });
  const calls = [];
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" } } };
  });
  bot.botInfo = BOT_INFO;
  return { bot, calls };
}

test("COMMANDS lists the seven commands", () => {
  assert.deepEqual(
    COMMANDS.map((c) => c.command),
    ["start", "open", "positions", "pnl", "wallet", "settings", "help"]
  );
});

test("foreign chat is ignored", async (t) => {
  const logMock = t.mock.method(console, "log", () => {}); // log.warn mencetak ke console
  let hits = 0;
  const { bot, calls } = build([{ register: (b) => b.command("start", () => void hits++) }]);
  await bot.handleUpdate(startUpdate(999));
  assert.equal(hits, 0);
  assert.equal(calls.length, 0);
  assert.ok(
    logMock.mock.calls.some((c) => String(c.arguments[0]).includes("[WARN]") && String(c.arguments[0]).includes("999"))
  );
});

test("owner chat reaches handlers", async () => {
  let hits = 0;
  const { bot } = build([{ register: (b) => b.command("start", () => void hits++) }]);
  await bot.handleUpdate(startUpdate(OWNER));
  assert.equal(hits, 1);
});

test("withGuard replies on throw", async (t) => {
  t.mock.method(console, "log", () => {}); // logger.error mencetak ke console
  const boom = withGuard("test", async () => {
    throw new Error("boom\nstack");
  });
  const { bot, calls } = build([{ register: (b) => b.command("start", boom) }]);
  await bot.handleUpdate(startUpdate(OWNER));
  const sent = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.text, "⚠️ test failed: boom");
});

test("withGuard answers callback queries even when the handler throws", async (t) => {
  t.mock.method(console, "log", () => {}); // logger.error mencetak ke console
  const boom = withGuard("cb", async () => {
    throw new Error("nope");
  });
  const { bot, calls } = build([{ register: (b) => b.callbackQuery("x:y", boom) }]);
  await bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: "q1",
      from: { id: OWNER, is_bot: false, first_name: "U" },
      chat_instance: "c",
      data: "x:y",
      message: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" }, text: "hi" },
    },
  });
  assert.ok(calls.some((c) => c.method === "answerCallbackQuery"));
  assert.ok(calls.some((c) => c.method === "sendMessage" && c.payload.text === "⚠️ cb failed: nope"));
});
