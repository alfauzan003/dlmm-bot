import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// File settings diarahkan ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tg-start-"));
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { buildHome, gatherHomeData, sendHome } = await import("../src/tg/start.js");
const { HELP_TEXT } = await import("../src/tg/help.js");
const { createBot } = await import("../src/tg/bot.js");
const startModule = await import("../src/tg/start.js");
const { DEFAULT_SETTINGS } = await import("../src/state/settings.js");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const BASE = {
  address: "WalletAddr1111111111111111111111111111111111",
  balanceSol: 1.5,
  solUsd: 100,
  openTrades: 2,
  openPnlUsd: 3.2,
  settings: DEFAULT_SETTINGS,
  dryRun: true,
};

test("buildHome shows DRY RUN badge and toggles", () => {
  const { text } = buildHome(BASE);
  assert.ok(text.includes("DRY RUN"));
  assert.ok(text.includes("Auto Exit"));
  assert.ok(!text.includes("DCA"));
  assert.ok(text.includes(`<code>${BASE.address}</code>`));
  assert.ok(text.includes("$150.00"));
});

test("buildHome hides DRY RUN badge when live", () => {
  assert.ok(!buildHome({ ...BASE, dryRun: false }).text.includes("DRY RUN"));
});

test("buildHome keyboard callback data", () => {
  const { keyboard } = buildHome(BASE);
  const data = keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(data, ["home:open", "home:positions", "home:pnl", "home:wallet", "home:settings", "home:help"]);
});

test("buildHome shows ? for missing values", () => {
  const { text } = buildHome({ ...BASE, address: null, balanceSol: null, solUsd: null, openPnlUsd: null });
  assert.ok(text.includes("?"));
});

test("gatherHomeData does not throw when sources fail", async (t) => {
  t.mock.method(console, "log", () => {}); // log.warn mencetak ke console
  const boom = async () => {
    throw new Error("down");
  };
  const data = await gatherHomeData({ getAddress: boom, getBalance: boom, getSolUsd: boom, getOpenTrades: boom });
  assert.equal(data.address, null);
  assert.equal(data.balanceSol, null);
  assert.equal(data.solUsd, null);
  assert.equal(data.openPnlUsd, null);
});

test("HELP_TEXT covers flows and commands", () => {
  for (const word of ["/open", "/positions", "/pnl", "/wallet", "/settings", "/help"]) {
    assert.ok(HELP_TEXT.includes(word), word);
  }
});

const DEPS = {
  getAddress: async () => "Addr1",
  getBalance: async () => 2,
  getSolUsd: async () => 100,
  getOpenTrades: async () => ({ count: 1, pnlUsd: -1 }),
};

test("sendHome via api sends to the configured chat with prefix and keyboard", async () => {
  const sent = [];
  const api = { sendMessage: async (chatId, text, extra) => void sent.push({ chatId, text, extra }) };
  await sendHome(api, { prefix: "🟢 Online", deps: DEPS });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.startsWith("🟢 Online\n"));
  assert.equal(sent[0].extra.parse_mode, "HTML");
  assert.ok(sent[0].extra.reply_markup.inline_keyboard.length > 0);
  assert.ok(sent[0].text.includes("$200.00"));
});

test("unbuilt home buttons answer Coming soon", async () => {
  const bot = createBot({ token: "123:dummy", chatId: "123", modules: [startModule] });
  const calls = [];
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: 123, type: "private" } } };
  });
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "T",
    username: "t_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
  await bot.handleUpdate({
    update_id: 9,
    callback_query: {
      id: "q",
      from: { id: 123, is_bot: false, first_name: "U" },
      chat_instance: "c",
      data: "home:pnl",
      message: { message_id: 1, date: 1, chat: { id: 123, type: "private" }, text: "x" },
    },
  });
  assert.ok(calls.some((c) => c.method === "sendMessage" && c.payload.text === "Coming soon"));
  assert.ok(calls.some((c) => c.method === "answerCallbackQuery"));
});
