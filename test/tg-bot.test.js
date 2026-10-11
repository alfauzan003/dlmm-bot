import test from "node:test";
import assert from "node:assert/strict";
import { createBot, withGuard, COMMANDS, registerPrompt, registerConfirm } from "../src/tg/bot.js";
import * as session from "../src/tg/session.js";

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

const POOL_ADDR = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y";
const sentTexts = (calls) => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text);
const cb = (data) => ({
  update_id: 7,
  callback_query: {
    id: "q7",
    from: { id: OWNER, is_bot: false, first_name: "U" },
    chat_instance: "c",
    data,
    message: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" }, text: "hi" },
  },
});

test("text router: pending prompt gets the text", async () => {
  const seen = [];
  registerPrompt("t-basic", async (ctx, prompt) => void seen.push([ctx.message.text, prompt.n]));
  session.put("prompt", { kind: "t-basic", n: 1 });
  const { bot, calls } = build([]);
  await bot.handleUpdate(startUpdate(OWNER, "20"));
  assert.deepEqual(seen, [["20", 1]]);
  assert.equal(calls.length, 0);
  session.del("prompt");
});

test("text router: an address clears a prompt that does not accept addresses", async () => {
  const seen = [];
  registerPrompt("t-noaddr", async (ctx) => void seen.push(ctx.message.text));
  session.put("prompt", { kind: "t-noaddr" });
  const { bot, calls } = build([]);
  await bot.handleUpdate(startUpdate(OWNER, POOL_ADDR));
  assert.deepEqual(seen, []);
  assert.equal(session.get("prompt"), null);
  assert.deepEqual(sentTexts(calls), ["Open wizard coming soon"]);
});

test("text router: a prompt registered with acceptsAddress keeps the address", async () => {
  const seen = [];
  registerPrompt("t-addr", async (ctx) => void seen.push(ctx.message.text), { acceptsAddress: true });
  session.put("prompt", { kind: "t-addr" });
  const { bot } = build([]);
  await bot.handleUpdate(startUpdate(OWNER, POOL_ADDR));
  assert.deepEqual(seen, [POOL_ADDR]);
  session.del("prompt");
});

test("text router: a slash message clears the prompt and skips the prompt handler", async () => {
  const seen = [];
  registerPrompt("t-slash", async (ctx) => void seen.push(ctx.message.text));
  session.put("prompt", { kind: "t-slash" });
  const { bot, calls } = build([]);
  await bot.handleUpdate(startUpdate(OWNER, "/unknown"));
  assert.deepEqual(seen, []);
  assert.equal(session.get("prompt"), null);
  assert.equal(calls.length, 0);
});

test("text router: a known command also clears the prompt", async () => {
  session.put("prompt", { kind: "t-slash" });
  let hits = 0;
  const { bot } = build([{ register: (b) => b.command("start", () => void hits++) }]);
  await bot.handleUpdate(startUpdate(OWNER, "/start"));
  assert.equal(hits, 1);
  assert.equal(session.get("prompt"), null);
});

test("text router: an address without a prompt goes to the open route", async () => {
  const { bot, calls } = build([]);
  await bot.handleUpdate(startUpdate(OWNER, `see https://solscan.io/account/${POOL_ADDR}`));
  assert.deepEqual(sentTexts(calls), ["Open wizard coming soon"]);
});

test("text router: other text gets a hint with the home keyboard", async () => {
  const { bot, calls } = build([]);
  await bot.handleUpdate(startUpdate(OWNER, "hello"));
  const msg = calls.find((c) => c.method === "sendMessage");
  assert.ok(msg.payload.text.length > 0);
  assert.ok(msg.payload.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "home:positions"));
});

test("ok: token dispatches to the confirm handler once, then expires", async () => {
  const seen = [];
  registerConfirm("t-act", async (ctx, payload) => void seen.push(payload));
  const token = session.issueToken({ action: "t-act", id: 5 });
  const { bot, calls } = build([]);
  await bot.handleUpdate(cb(`ok:${token}`));
  await bot.handleUpdate(cb(`ok:${token}`));
  assert.deepEqual(seen, [{ action: "t-act", id: 5 }]);
  const alerts = calls.filter((c) => c.method === "answerCallbackQuery" && c.payload.text);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].payload.text, "This button expired — start again");
});
