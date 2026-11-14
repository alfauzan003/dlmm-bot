import test from "node:test";
import assert from "node:assert/strict";

const { createBot } = await import("../src/tg/bot.js");
const swapModule = await import("../src/tg/swap.js");

const { buildSwapList, slippageLabel, tokenLabel, deps } = swapModule;
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
  deps.getTokenNames = async (mints) => new Map(mints.map((m) => [m, { name: "Bonk", symbol: "BONK" }]));
  deps.quoteToSol = async () => ({ outSol: 0.5, slippageBps: 100 });
  deps.getSolUsd = async () => 200;
  deps.getSlippage = () => ({ rtse: false, bps: 100 });
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

test("tokenLabel and slippageLabel", () => {
  assert.equal(tokenLabel(MINT, { name: "Bonk", symbol: "BONK" }), "Bonk (BONK)");
  assert.equal(tokenLabel(MINT, null, "DezXAZ8z"), "DezXAZ8z");
  assert.equal(slippageLabel({ rtse: false, bps: 100 }), "1% (100 bps)");
  assert.equal(slippageLabel({ rtse: true, bps: 100 }), "RTSE");
  assert.equal(slippageLabel({ rtse: true, bps: 100 }, 250), "RTSE (~2.5%)");
});

test("list buttons show the token name", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate("/swap"));
  assert.equal(lastMarkup(calls)[0].text, "Bonk (BONK): 1,000 ($5.00)");
});

test("confirm card shows name, SOL and USD estimate, and slippage", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`swp:${MINT}`));
  const text = texts(calls).at(-1);
  assert.ok(text.includes("Token: Bonk (BONK)"), text);
  assert.ok(text.includes("≈ 0.5 SOL ($100.00)"), text);
  assert.ok(text.includes("Slippage: 1% (100 bps)"), text);
});

test("confirm card survives a failed quote and shows RTSE", async () => {
  deps.quoteToSol = async () => {
    throw new Error("V2 quote failed: 500");
  };
  deps.getSlippage = () => ({ rtse: true, bps: 100 });
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`swp:${MINT}`));
  const text = texts(calls).at(-1);
  assert.ok(text.includes("≈ ? SOL (?)"), text);
  assert.ok(text.includes("Slippage: RTSE"), text);
});

test("refresh re-quotes, edits the card and swaps the old token for a new one", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`swp:${MINT}`));
  const oldKb = lastMarkup(calls);
  const refresh = oldKb.find((b) => b.text === "🔄 Refresh").callback_data;
  deps.quoteToSol = async () => ({ outSol: 0.6, slippageBps: 100 });
  await bot.handleUpdate(cbUpdate(refresh));
  const edit = calls.findLast((c) => c.method === "editMessageText");
  assert.ok(edit.payload.text.includes("≈ 0.6 SOL ($120.00)"), edit.payload.text);
  // token lama tidak berlaku lagi
  await bot.handleUpdate(cbUpdate(oldKb.find((b) => b.text === "✅ Confirm").callback_data));
  assert.equal(swaps.length, 0);
  const fresh = edit.payload.reply_markup.inline_keyboard.flat().find((b) => b.text === "✅ Confirm").callback_data;
  await bot.handleUpdate(cbUpdate(fresh));
  assert.deepEqual(swaps, [{ mint: MINT, amount: 1000 }]);
});

test("refresh with an expired token alerts", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("swp:r:zzzzzzzz"));
  const alert = calls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(alert.payload.show_alert);
});
