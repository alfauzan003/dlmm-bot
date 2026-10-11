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
const { trackPosition, recordClose } = await import("../src/state/positions.js");

const { tradeLine, buildPositionsList, buildTradeDetail, liveForTrade, rangeBar, deps } = positionsModule;
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
  assert.deepEqual(liveForTrade(trade, null), {
    pnlPct: null,
    pnlUsd: null,
    inRange: null,
    feesUsd: null,
    feesSol: null,
    valueUsd: null,
    valueSol: null,
    bins: null,
  });
  assert.equal(inside.valueUsd, 22);
  assert.deepEqual(inside.bins, { lower: 0, upper: 10, active: 5, binStep: null, xIsSol: false });
  assert.equal(missing.bins, null);
});

test("liveForTrade sums SOL value and SOL fees only when every open leg reports them", () => {
  const leg = (valueSol, unclaimedFee) => ({ activeBin: 5, lowerBin: 0, upperBin: 10, valueSol, unclaimedFee });
  const trade = { positions: ["VA", "VB"] };
  const both = liveForTrade(
    trade,
    new Map([
      ["VA", leg(0.25, 0.001)],
      ["VB", leg(0.5, 0.002)],
    ])
  );
  assert.equal(both.valueSol, 0.75);
  assert.equal(both.feesSol, 0.003);
  const partial = liveForTrade(
    trade,
    new Map([
      ["VA", leg(0.25, 0.001)],
      ["VB", leg(undefined, undefined)],
    ])
  );
  assert.equal(partial.valueSol, null);
  assert.equal(partial.feesSol, null);
});

test("rangeBar: price distance of min/max from the current price, or how far outside the range", () => {
  const b = (active, extra = {}) => ({ lower: 0, upper: 10, active, binStep: 100, ...extra });
  assert.equal(rangeBar(b(5)), "[██████░░░░░░] min -4.85% · max +5.10%");
  assert.equal(rangeBar(b(0)), "[░░░░░░░░░░░░] min +0.00% · max +10.46%");
  assert.equal(rangeBar(b(10)), "[████████████] min -9.47% · max +0.00%");
  assert.equal(rangeBar(b(-3)), "[░░░░░░░░░░░░] 2.94% below range");
  assert.equal(rangeBar(b(11)), "[████████████] 1.00% above range");
  // SOL = token X: token price moves opposite to the bin id.
  assert.equal(rangeBar(b(2, { xIsSol: true })), "[██████████░░] min -7.65% · max +2.01%");
  assert.equal(rangeBar(b(11, { xIsSol: true })), "[░░░░░░░░░░░░] 0.99% below range");
  assert.equal(rangeBar(null), null);
});

test("rangeBar without binStep falls back to bins", () => {
  assert.equal(rangeBar({ lower: 0, upper: 10, active: 5 }), "[██████░░░░░░] 50% from min");
  assert.equal(rangeBar({ lower: -587, upper: -527, active: -527 }), "[████████████] 100% from min");
  assert.equal(rangeBar({ lower: 0, upper: 10, active: -3 }), "[░░░░░░░░░░░░] 3 bins below range");
  assert.equal(rangeBar({ lower: 0, upper: 10, active: 11 }), "[████████████] 1 bin above range");
});

test("liveForTrade ignores legs already closed in state", () => {
  trackPosition("CA", "PoolA", "BONK-SOL", "MintA", null, "spot");
  recordClose("CA", "manual", 0, { pnlUsd: 0 });
  const trade = { positions: ["CA", "CB"] };
  const live = liveForTrade(
    trade,
    new Map([["CB", { activeBin: 5, lowerBin: 0, upperBin: 10, pnlUsd: -4, depositUsd: 10, pnlKnown: true }]])
  );
  assert.equal(live.pnlPct, -40);
  assert.equal(live.inRange, true);
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

test("buildTradeDetail shows status, value, PnL, fees, range bar and exits", () => {
  const MINT = "33jENUQnjoitkMFpvNJcSHyLAHFWJuHwT6E3E8CNpump";
  const trade = {
    id: 7,
    pool: "Pool",
    pair: "A-SOL",
    baseMint: MINT,
    shape: "spot",
    origin: "manual",
    depositSol: 1,
    exit: EXIT(),
    range: { below: 45, above: 10, lowerBin: 100, upperBin: 155 },
    peakPnlPct: 6.5,
    openedAt: 0,
  };
  const live = {
    pnlPct: -0.6,
    pnlUsd: -0.597,
    inRange: true,
    feesUsd: 0.5233,
    feesSol: 0.0025,
    valueUsd: 98.88,
    valueSol: 0.4712,
    bins: { lower: 100, upper: 155, active: 122 },
  };
  const { text } = buildTradeDetail(trade, live, 2 * 3600_000);
  const lines = text.split("\n");
  assert.equal(lines[0], "📂 Trade #7");
  assert.equal(lines[2], `🟢 IN · <a href="https://gmgn.ai/sol/token/${MINT}">A-SOL</a> · 2h · $98.88 (0.4712 SOL)`);
  assert.equal(lines[3], "PnL -$0.60 (-0.60%) · fees $0.52 (0.0025 SOL)");
  assert.equal(lines[4], "spot · Range -45% / +10% · bins 100–155");
  assert.equal(lines[5], "[█████░░░░░░░] 40% from min");
  assert.ok(text.includes("TP15 SL-25 T5/3 · Peak PnL +6.50%"), text);
  assert.ok(text.includes("deposit 1 SOL"), text);
  assert.ok(text.includes("Origin manual"), text);

  const adopted = { ...trade, baseMint: "not a mint", origin: "external", range: null, peakPnlPct: null };
  const plain = buildTradeDetail(adopted, null).text;
  assert.ok(plain.includes("⚪ ? · A-SOL · "), plain);
  assert.ok(!plain.includes("<a "), plain);
  assert.ok(plain.includes("PnL ? · fees ?"), plain);
  assert.ok(plain.includes("Range ?"), plain);
  assert.ok(!plain.includes("from min"), plain);
  assert.ok(plain.includes("Peak PnL ?"), plain);
  assert.ok(plain.includes("Origin external"), plain);

  const out = buildTradeDetail(trade, { ...live, inRange: false, bins: { lower: 100, upper: 155, active: 90 } }).text;
  assert.ok(out.includes("🔴 OUT · "), out);
  assert.ok(out.includes("10 bins below range"), out);
});

test("liveForTrade sums unclaimed fees only when every open leg reports them", () => {
  const leg = (fee) => ({
    activeBin: 5,
    lowerBin: 0,
    upperBin: 10,
    pnlUsd: 1,
    depositUsd: 10,
    pnlKnown: true,
    unclaimedFeeUsd: fee,
  });
  const trade = { positions: ["FA", "FB"] };
  assert.equal(
    liveForTrade(
      trade,
      new Map([
        ["FA", leg(1)],
        ["FB", leg(2.5)],
      ])
    ).feesUsd,
    3.5
  );
  assert.equal(
    liveForTrade(
      trade,
      new Map([
        ["FA", leg(1)],
        ["FB", leg(undefined)],
      ])
    ).feesUsd,
    null
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
  assert.ok(text.includes("PnL $3.10 (+3.10%)"), text);
  assert.ok(text.includes("🟢 IN · BONK-SOL · "), text);
  assert.ok(text.includes("$103.10"), text);
  assert.ok(text.includes("[██████░░░░░░] 50% from min"), text);
  const edit = calls.find((c) => c.method === "editMessageText");
  assert.deepEqual(edit.payload.link_preview_options, { is_disabled: true });
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

test("close succeeded but the final edit fails: the result is sent as a new message", async (t) => {
  t.mock.method(console, "log", () => {}); // logger mencetak ke console
  const trade = newTrade();
  deps.closeTrade = async (tr) => ({ success: true, trade: tr, failed: [], swapInfo: null });
  const { bot, calls } = build();
  const { swap } = await tokens(bot, calls, trade.id);
  // Edit pertama (progres) berhasil, edit hasil akhir gagal (mis. pesan sudah dihapus).
  let editsSeen = 0;
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === "editMessageText" && ++editsSeen === 2) {
      return { ok: false, error_code: 400, description: "Bad Request: message to edit not found" };
    }
    return prev(method, payload, signal);
  });
  const before = calls.length;
  await bot.handleUpdate(cbUpdate(swap));
  const texts = sent(calls.slice(before));
  assert.equal(texts.length, 1);
  assert.ok(texts[0].includes(`✅ Trade #${trade.id} closed.`), texts[0]);
  assert.ok(!texts.some((x) => x.includes("Close failed")));
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

// --- Flip ---

test("buildTradeDetail shows Flip only for bid_ask and mixed", () => {
  const base = { id: 7, pool: "Pool", pair: "A-SOL", origin: "manual", depositSol: 1, exit: EXIT() };
  const closeRow = (shape) =>
    buildTradeDetail({ ...base, shape }, null).keyboard.inline_keyboard[2].map((b) => [b.text, b.callback_data]);
  for (const shape of ["bid_ask", "mixed"]) {
    assert.deepEqual(closeRow(shape), [
      ["❌ Close", "pos:close:7"],
      ["🔁 Flip", "pos:flip:7"],
    ]);
  }
  for (const shape of ["spot", "curve", null]) assert.deepEqual(closeRow(shape), [["❌ Close", "pos:close:7"]]);
});

async function flipToken(bot, calls, id) {
  const before = calls.length;
  await bot.handleUpdate(cbUpdate(`pos:flip:${id}`));
  const payload = calls.slice(before).find((c) => c.method === "editMessageText").payload;
  return { payload, flip: buttons(payload).find((b) => b.text === "Flip")?.callback_data };
}

test("flip confirm shows the planned bin count", async () => {
  const trade = newTrade({ shape: "bid_ask" });
  deps.planFlip = async () => ({ binCount: 12, legs: [], newRange: { minBinId: 1, maxBinId: 12 } });
  const { bot, calls } = build();
  const { payload, flip } = await flipToken(bot, calls, trade.id);
  assert.ok(payload.text.includes("Flip 12 bins → new token position over 12 bins above price."));
  assert.match(flip, /^ok:/);
  assert.ok(buttons(payload).some((b) => b.text === "Cancel" && b.callback_data === `pos:open:${trade.id}`));
});

test("flip with nothing to flip shows the nothing message and no confirm token", async () => {
  const trade = newTrade({ shape: "bid_ask" });
  deps.planFlip = async () => ({ binCount: 0 });
  const { bot, calls } = build();
  const { payload, flip } = await flipToken(bot, calls, trade.id);
  assert.ok(payload.text.includes("Nothing to flip — no token-only bins yet."));
  assert.equal(flip, undefined);
});

test("flip plan error is shown", async () => {
  const trade = newTrade({ shape: "bid_ask" });
  deps.planFlip = async () => ({ error: "too many positions (10)" });
  const { bot, calls } = build();
  const { payload, flip } = await flipToken(bot, calls, trade.id);
  assert.ok(payload.text.includes("⚠️ Could not flip: too many positions (10)"));
  assert.equal(flip, undefined);
});

test("flip token is one-shot and reports success", async () => {
  const trade = newTrade({ shape: "mixed" });
  deps.planFlip = async () => ({ binCount: 12 });
  const flips = [];
  deps.flipTrade = async (t) => {
    flips.push(t.id);
    return { success: true, binCount: 12, tokenAmount: 1234.5, position: "New" };
  };
  const { bot, calls } = build();
  const { flip } = await flipToken(bot, calls, trade.id);
  await bot.handleUpdate(cbUpdate(flip));
  await bot.handleUpdate(cbUpdate(flip));
  assert.deepEqual(flips, [trade.id]);
  assert.ok(edits(calls).some((t) => t.includes("⏳ Flipping…")));
  assert.ok(edits(calls).some((t) => t.includes("✅ Flipped 12 bins (1,234.5 token) → new position over 12 bins.")));
  assert.ok(answers(calls).some((c) => c.payload.text === "This button expired — start again"));
});

test("flip re-deposit failure shows the kept-in-wallet message", async () => {
  const trade = newTrade({ shape: "bid_ask" });
  deps.planFlip = async () => ({ binCount: 3 });
  deps.flipTrade = async () => ({ success: false, redepositFailed: true, binCount: 3, tokenAmount: 5 });
  const { bot, calls } = build();
  const { flip } = await flipToken(bot, calls, trade.id);
  await bot.handleUpdate(cbUpdate(flip));
  assert.ok(edits(calls).some((t) => t.includes("⚠️ Withdrawn but re-deposit failed — token kept in wallet.")));
});

test("flip in dry run says so", async () => {
  const trade = newTrade({ shape: "bid_ask" });
  deps.planFlip = async () => ({ binCount: 4 });
  deps.flipTrade = async () => ({ success: true, dryRun: true, binCount: 4 });
  const { bot, calls } = build();
  const { flip } = await flipToken(bot, calls, trade.id);
  await bot.handleUpdate(cbUpdate(flip));
  assert.ok(edits(calls).some((t) => t.includes("🧪 DRY RUN — would flip 4 bins → new position over 4 bins.")));
});
