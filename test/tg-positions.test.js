import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// File state/settings diarahkan ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tg-positions-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { createBot } = await import("../src/tg/bot.js");
const positionsModule = await import("../src/tg/positions.js");
const session = await import("../src/tg/session.js");
const { createTrade, getTrade } = await import("../src/state/trades.js");

const { tradeLine, buildPositionsList, buildTradeDetail, liveForTrade, deps } = positionsModule;
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
const ORIGINAL_DEPS = { ...deps };
const POOL_ADDR = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y";

const EXIT = () => ({
  tp: { on: true, pct: 15 },
  sl: { on: true, pct: 25 },
  trail: { on: true, startPct: 5, distancePct: 3 },
});

function newTrade(extra = {}) {
  return createTrade({
    pool: "PoolA",
    pair: "BONK-SOL",
    baseMint: "MintA",
    positions: ["PosA"],
    shape: "spot",
    depositSol: 0.5,
    origin: "manual",
    exit: EXIT(),
    ...extra,
  });
}

test.beforeEach(() => {
  fs.rmSync(process.env.STATE_FILE, { force: true });
  session.del("prompt");
  Object.assign(deps, ORIGINAL_DEPS);
  deps.getOpenPositions = async () => null;
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function build() {
  const bot = createBot({ token: "123:dummy", chatId: String(OWNER), modules: [positionsModule] });
  const calls = [];
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" } } };
  });
  bot.botInfo = BOT_INFO;
  return { bot, calls };
}

let updateId = 100;
const cbUpdate = (data, text = "📂 Trade #1") => ({
  update_id: updateId++,
  callback_query: {
    id: `q${updateId}`,
    from: { id: OWNER, is_bot: false, first_name: "U" },
    chat_instance: "c",
    data,
    message: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" }, text },
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
    entities: text.startsWith("/")
      ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }]
      : undefined,
  },
});

const sent = (calls) => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text);
const edits = (calls) => calls.filter((c) => c.method === "editMessageText").map((c) => c.payload.text);
const answers = (calls) => calls.filter((c) => c.method === "answerCallbackQuery");
const buttons = (payload) => payload.reply_markup.inline_keyboard.flat();

test("tradeLine matches the documented format", () => {
  const trade = { id: 12, pair: "BONK-SOL", shape: "spot", origin: "manual", depositSol: 0.5, exit: EXIT() };
  const line = tradeLine(trade, { pnlPct: 4.2, pnlUsd: 3.1, inRange: true });
  assert.equal(line, "#12 BONK-SOL · spot · 0.5 SOL · +4.20% ($3.10) · in range · TP15 SL-25 T5/3");
});

test("tradeLine shows PnL ? when unknown and omits range without live data", () => {
  const trade = { id: 3, pair: "AAA-SOL", shape: "spot", origin: "manual", depositSol: 1, exit: EXIT() };
  const line = tradeLine(trade, { pnlPct: null, pnlUsd: null, inRange: null });
  assert.ok(line.includes("PnL ?"));
  assert.ok(!line.includes("range"));
  assert.ok(tradeLine(trade, null).includes("PnL ?"));
});

test("tradeLine uses the origin label when shape is null", () => {
  const trade = { id: 4, pair: "AAA-SOL", shape: null, origin: "external", depositSol: null, exit: EXIT() };
  const line = tradeLine(trade, { pnlPct: -1, pnlUsd: -0.5, inRange: false });
  assert.ok(line.startsWith("#4 AAA-SOL · external · "));
  assert.ok(line.includes("out of range"));
  assert.ok(line.includes("-1.00% (-$0.50)"));
});

test("liveForTrade: range is derived from every leg and PnL from the aggregate", () => {
  const trade = { positions: ["A", "B"] };
  const leg = (activeBin, lowerBin, upperBin) => ({
    activeBin,
    lowerBin,
    upperBin,
    pnlUsd: 1,
    depositUsd: 10,
    pnlKnown: true,
  });
  const inside = liveForTrade(
    trade,
    new Map([
      ["A", leg(5, 0, 10)],
      ["B", leg(5, 5, 10)],
    ])
  );
  assert.equal(inside.inRange, true);
  assert.equal(inside.pnlUsd, 2);
  assert.equal(inside.pnlPct, 10);
  const outside = liveForTrade(
    trade,
    new Map([
      ["A", leg(5, 0, 10)],
      ["B", leg(5, 6, 10)],
    ])
  );
  assert.equal(outside.inRange, false);
  const missing = liveForTrade(trade, new Map([["A", leg(5, 0, 10)]]));
  assert.equal(missing.inRange, null);
  assert.equal(missing.pnlPct, null);
  assert.deepEqual(liveForTrade(trade, null), { pnlPct: null, pnlUsd: null, inRange: null });
});

test("buildPositionsList: one button per trade; empty state offers Open", () => {
  const t1 = { id: 1, pair: "A-SOL", shape: "spot", origin: "manual", depositSol: 1, exit: EXIT() };
  const t2 = { id: 2, pair: "B-SOL", shape: null, origin: "auto", depositSol: 1, exit: EXIT() };
  const { text, keyboard } = buildPositionsList([t1, t2], new Map());
  const data = keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes("pos:open:1"));
  assert.ok(data.includes("pos:open:2"));
  assert.ok(text.includes("#1 A-SOL"));

  const empty = buildPositionsList([], new Map());
  assert.equal(empty.text, "No open positions.");
  assert.deepEqual(
    empty.keyboard.inline_keyboard.flat().map((b) => [b.text, b.callback_data]),
    [["➕ Open", "home:open"]]
  );
});

test("buildTradeDetail has the documented buttons", () => {
  const trade = { id: 7, pool: "Pool", pair: "A-SOL", shape: "spot", origin: "manual", depositSol: 1, exit: EXIT() };
  const { keyboard } = buildTradeDetail(trade, null);
  assert.deepEqual(
    keyboard.inline_keyboard.map((row) => row.map((b) => [b.text, b.callback_data])),
    [
      [
        ["💰 Claim", "pos:claim:7"],
        ["💰 Claim+swap", "pos:claimswap:7"],
      ],
      [
        ["🎯 TP", "pos:tp:7"],
        ["🛑 SL", "pos:sl:7"],
        ["📈 Trail", "pos:trail:7"],
      ],
      [["❌ Close", "pos:close:7"]],
      [
        ["🔄 Refresh", "pos:open:7"],
        ["◀ Back", "home:positions"],
      ],
    ]
  );
});

test("/positions lists open trades", async () => {
  const trade = newTrade();
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate("/positions"));
  const msg = calls.find((c) => c.method === "sendMessage");
  assert.ok(msg.payload.text.includes(`#${trade.id} BONK-SOL`));
  assert.ok(buttons(msg.payload).some((b) => b.callback_data === `pos:open:${trade.id}`));
});

test("home:positions with no trades says so", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("home:positions", "🏠 Meteora LP Assistant"));
  assert.deepEqual(sent(calls), ["No open positions."]);
});

test("home:positions from a trade screen edits that message instead of sending a new one", async () => {
  newTrade();
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("home:positions", "📂 Trade #1\nBONK-SOL"));
  assert.equal(sent(calls).length, 0);
  assert.equal(edits(calls).length, 1);
});

test("pos:open shows the detail with live data", async () => {
  const trade = newTrade();
  deps.getOpenPositions = async () => [
    { position: "PosA", activeBin: 5, lowerBin: 0, upperBin: 10, pnlUsd: 3.1, depositUsd: 100, pnlKnown: true },
  ];
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`pos:open:${trade.id}`));
  const [text] = edits(calls);
  assert.ok(text.includes("+3.10% ($3.10)"));
  assert.ok(text.includes("in range"));
});

test("pos:open on a closed or unknown trade says it is not open", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("pos:open:99"));
  assert.ok(sent(calls)[0].includes("not open"));
});

test("TP prompt: valid number updates the trade, bad text is rejected", async () => {
  const trade = newTrade();
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`pos:tp:${trade.id}`));
  assert.equal(session.get("prompt").kind, "pos-exit");

  await bot.handleUpdate(textUpdate("abc"));
  assert.ok(sent(calls).at(-1).includes("Invalid"));
  assert.deepEqual(getTrade(trade.id).exit.tp, { on: true, pct: 15 });
  assert.ok(session.get("prompt"));

  await bot.handleUpdate(textUpdate("20"));
  assert.deepEqual(getTrade(trade.id).exit.tp, { on: true, pct: 20 });
  assert.equal(session.get("prompt"), null);
});

test("SL off and Trail values are applied", async () => {
  const trade = newTrade();
  const { bot } = build();
  await bot.handleUpdate(cbUpdate(`pos:sl:${trade.id}`));
  await bot.handleUpdate(textUpdate("off"));
  assert.equal(getTrade(trade.id).exit.sl.on, false);

  await bot.handleUpdate(cbUpdate(`pos:trail:${trade.id}`));
  await bot.handleUpdate(textUpdate("8 2.5"));
  assert.deepEqual(getTrade(trade.id).exit.trail, { on: true, startPct: 8, distancePct: 2.5 });
});

test("a pasted address during a TP prompt goes to the open route and clears the prompt", async () => {
  const trade = newTrade();
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`pos:tp:${trade.id}`));
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  assert.equal(session.get("prompt"), null);
  assert.equal(getTrade(trade.id).exit.tp.pct, 15);
  assert.ok(sent(calls).at(-1).includes("Open wizard coming soon"));
});

test("pos:close shows the confirm keyboard with one-shot tokens", async () => {
  const trade = newTrade();
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`pos:close:${trade.id}`));
  const payload = calls.find((c) => c.method === "editMessageText").payload;
  const btns = buttons(payload);
  assert.deepEqual(
    btns.map((b) => b.text),
    ["Close + swap to SOL", "Close only", "Cancel"]
  );
  assert.ok(btns[0].callback_data.startsWith("ok:"));
  assert.ok(btns[1].callback_data.startsWith("ok:"));
  assert.equal(btns[2].callback_data, `pos:open:${trade.id}`);
});

async function tokens(bot, calls, id) {
  const before = calls.length;
  await bot.handleUpdate(cbUpdate(`pos:close:${id}`));
  const payload = calls.slice(before).find((c) => c.method === "editMessageText").payload;
  const [swap, only] = buttons(payload);
  return { swap: swap.callback_data, only: only.callback_data };
}

test("close token is one-shot: second press does not close again", async () => {
  const trade = newTrade();
  const closeCalls = [];
  deps.closeTrade = async (t, opts) => {
    closeCalls.push({ id: t.id, ...opts });
    return { success: true, trade: { ...t, closed: true }, failed: [], swapInfo: null };
  };
  const { bot, calls } = build();
  const { swap } = await tokens(bot, calls, trade.id);

  await bot.handleUpdate(cbUpdate(swap));
  await bot.handleUpdate(cbUpdate(swap));

  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].reason, "manual");
  assert.equal(closeCalls[0].swap, true);
  assert.ok(edits(calls).some((t) => t.includes("Closing")));
  assert.ok(edits(calls).some((t) => t.includes("closed")));
  assert.ok(answers(calls).some((c) => c.payload.text === "This button expired — start again"));
});

test("Close only passes swap=false", async () => {
  const trade = newTrade();
  let opts;
  deps.closeTrade = async (t, o) => {
    opts = o;
    return { success: true, trade: t, failed: [], swapInfo: null };
  };
  const { bot, calls } = build();
  const { only } = await tokens(bot, calls, trade.id);
  await bot.handleUpdate(cbUpdate(only));
  assert.equal(opts.swap, false);
});

test("close: busy and partial failure messages", async () => {
  const trade = newTrade();
  const { bot, calls } = build();
  deps.closeTrade = async () => ({ success: false, busy: true, failed: [], swapInfo: null });
  let t = await tokens(bot, calls, trade.id);
  await bot.handleUpdate(cbUpdate(t.swap));
  assert.ok(edits(calls).at(-1).includes("Busy — another action is running on this trade"));

  deps.closeTrade = async () => ({ success: false, failed: ["PosA"], swapInfo: null });
  t = await tokens(bot, calls, trade.id);
  await bot.handleUpdate(cbUpdate(t.swap));
  assert.ok(edits(calls).at(-1).includes("1 position(s) could not be closed"));
});

test("expired confirm token answers with an alert", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("ok:nonexistent"));
  assert.ok(answers(calls).some((c) => c.payload.text === "This button expired — start again"));
});

test("claim: success, swap flag, failed legs and busy", async () => {
  const trade = newTrade();
  const seen = [];
  deps.claimTrade = async (t, o) => {
    seen.push(o);
    return { success: true, claimed: 1, failed: [], swapInfo: null };
  };
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate(`pos:claim:${trade.id}`));
  await bot.handleUpdate(cbUpdate(`pos:claimswap:${trade.id}`));
  assert.deepEqual(
    seen.map((o) => o.swap),
    [false, true]
  );
  assert.ok(edits(calls).some((t) => t.includes("Claiming")));
  assert.ok(edits(calls).some((t) => t.includes("Claimed fees from 1 position(s)")));

  deps.claimTrade = async () => ({ success: false, claimed: 1, failed: ["PosB"], swapInfo: null });
  await bot.handleUpdate(cbUpdate(`pos:claim:${trade.id}`));
  const last = edits(calls).at(-1);
  assert.ok(last.includes("Claimed 1 position(s)"));
  assert.ok(last.includes("1 position(s) could not be claimed (they may have no fees yet — see logs)"));

  deps.claimTrade = async () => ({ success: false, busy: true, claimed: 0, failed: [], swapInfo: null });
  await bot.handleUpdate(cbUpdate(`pos:claim:${trade.id}`));
  assert.ok(edits(calls).at(-1).includes("Busy — another action is running on this trade"));
});

test("summarizeOpenTrades sums only known trade PnL", async () => {
  newTrade();
  newTrade({ positions: ["PosB"] });
  deps.getOpenPositions = async () => [
    { position: "PosA", activeBin: 5, lowerBin: 0, upperBin: 10, pnlUsd: 3, depositUsd: 100, pnlKnown: true },
    { position: "PosB", activeBin: 5, lowerBin: 0, upperBin: 10, pnlUsd: 9, depositUsd: 100, pnlKnown: false },
  ];
  assert.deepEqual(await positionsModule.summarizeOpenTrades(), { count: 2, pnlUsd: 3, partial: true });
  deps.getOpenPositions = async () => null;
  assert.deepEqual(await positionsModule.summarizeOpenTrades(), { count: 2, pnlUsd: null, partial: true });
});
