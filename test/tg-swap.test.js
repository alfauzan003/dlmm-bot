import test from "node:test";
import assert from "node:assert/strict";

const { createBot } = await import("../src/tg/bot.js");
const swapModule = await import("../src/tg/swap.js");

const { buildSwapList, deps } = swapModule;
const OWNER = 123;
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
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
const ORIGINAL_DEPS = { ...deps };

let swaps = [];
let tokenBalance = 1000;

test.beforeEach((t) => {
  for (const m of ["log", "info", "warn", "error", "debug"]) t.mock.method(console, m, () => {});
  Object.assign(deps, ORIGINAL_DEPS);
  swaps = [];
  tokenBalance = 1000;
  deps.getBalances = async () => ({ sol: 1, tokens: [{ mint: MINT, balance: 1000, usd: 5, symbol: "BONK" }] });
  deps.getTokenBalance = async () => tokenBalance;
  deps.isDryRun = () => false;
  deps.isOpenInProgress = () => false;
  deps.swapToSol = async (mint, amount) => {
    swaps.push({ mint, amount });
    return { success: true, tx: "TXSIG" };
  };
});

function build() {
  const bot = createBot({ token: "123:dummy", chatId: String(OWNER), modules: [swapModule] });
  const calls = [];
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: 77, date: 1, chat: { id: OWNER, type: "private" } } };
  });
  bot.botInfo = BOT_INFO;
  return { bot, calls };
}

let updateId = 100;
const cbUpdate = (data) => ({
  update_id: updateId++,
  callback_query: {
    id: `q${updateId}`,
    from: { id: OWNER, is_bot: false, first_name: "U" },
    chat_instance: "c",
    data,
    message: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" }, text: "card" },
  },
});
const textUpdate = (text) => ({
  update_id: updateId++,
  message: {
    message_id: 5,
    date: 1,
    chat: { id: OWNER, type: "private", first_name: "U" },
    from: { id: OWNER, is_bot: false, first_name: "U" },
    text,
    entities: [{ type: "bot_command", offset: 0, length: text.length }],
  },
});
const texts = (calls) =>
  calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map((c) => c.payload.text);
const lastMarkup = (calls) =>
  [...calls]
    .reverse()
    .find((c) => c.payload.reply_markup)
    ?.payload.reply_markup.inline_keyboard.flat() ?? [];

test("buildSwapList with no tokens has no keyboard", () => {
  const { text, keyboard } = buildSwapList([]);
  assert.ok(text.includes("No tokens"));
  assert.equal(keyboard, null);
});

test("/swap and home:swap list wallet tokens as buttons", async () => {
  for (const update of [textUpdate("/swap"), cbUpdate("home:swap")]) {
    const { bot, calls } = build();
    await bot.handleUpdate(update);
    assert.deepEqual(
      lastMarkup(calls).map((b) => b.callback_data),
      [`swp:${MINT}`]
    );
  }
});

test("pick → confirm swaps the whole balance to SOL", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`swp:${MINT}`));
  const confirm = lastMarkup(calls).find((b) => b.text === "✅ Confirm").callback_data;
  tokenBalance = 1200; // saldo dibaca ulang saat konfirmasi
  await bot.handleUpdate(cbUpdate(confirm));
  assert.deepEqual(swaps, [{ mint: MINT, amount: 1200 }]);
  assert.ok(texts(calls).at(-1).includes("✅ Swapped"));
});

test("confirm is refused while an open is in progress", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`swp:${MINT}`));
  const confirm = lastMarkup(calls).find((b) => b.text === "✅ Confirm").callback_data;
  deps.isOpenInProgress = () => true;
  await bot.handleUpdate(cbUpdate(confirm));
  assert.equal(swaps.length, 0);
  assert.ok(texts(calls).at(-1).includes("open is in progress"));
});

test("cancel drops the confirm token", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`swp:${MINT}`));
  const kb = lastMarkup(calls);
  await bot.handleUpdate(cbUpdate(kb.find((b) => b.text === "✖ Cancel").callback_data));
  await bot.handleUpdate(cbUpdate(kb.find((b) => b.text === "✅ Confirm").callback_data));
  assert.equal(swaps.length, 0);
});
