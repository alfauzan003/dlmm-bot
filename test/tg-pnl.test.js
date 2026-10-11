import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// File state/settings diarahkan ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tg-pnl-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { createBot } = await import("../src/tg/bot.js");
const pnlModule = await import("../src/tg/pnl.js");
const startModule = await import("../src/tg/start.js");
const { createTrade } = await import("../src/state/trades.js");
const { readState, writeState } = await import("../src/state/store.js");

const { buildPnl, buildRecent, deps } = pnlModule;
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
const buttons = (x) => (x.inline_keyboard ?? x.reply_markup.inline_keyboard).flat();
const EMPTY = { count: 0, wins: 0, winRatePct: null, pnlUsd: 0, best: null, worst: null };

test.beforeEach(() => {
  fs.rmSync(process.env.STATE_FILE, { force: true });
  Object.assign(deps, ORIGINAL_DEPS);
  deps.summarizeOpenTrades = async () => ({ count: 0, pnlUsd: 0, partial: false });
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("buildPnl shows the summary and marks the active tab", () => {
  const summary = {
    count: 3,
    wins: 1,
    winRatePct: 50,
    pnlUsd: 2,
    best: { id: 1, pair: "AAA-SOL", closePnlUsd: 3 },
    worst: { id: 2, pair: "B<B-SOL", closePnlUsd: -1 },
  };
  const { text, keyboard } = buildPnl("week", summary, 1.5);
  assert.ok(text.includes("This week"));
  assert.ok(text.includes("$2.00"));
  assert.ok(text.includes("50%"));
  assert.ok(text.includes("#1 AAA-SOL"));
  assert.ok(text.includes("B&lt;B-SOL"));
  assert.ok(text.includes("$1.50"));
  const all = buttons(keyboard);
  assert.deepEqual(
    all.map((b) => b.callback_data),
    ["pnl:today", "pnl:week", "pnl:month", "pnl:recent"]
  );
  assert.ok(all[1].text.startsWith("•"));
  assert.ok(!all[0].text.startsWith("•"));
  assert.ok(all[3].text.includes("Recent closes"));
});

test("buildPnl shows a dash for win rate with no known trades and marks partial open PnL", () => {
  const { text } = buildPnl("today", EMPTY, 2, true);
  assert.ok(text.includes("—"));
  assert.ok(text.includes("(partial)"));
  assert.ok(!buildPnl("today", EMPTY, 2, false).text.includes("(partial)"));
  assert.ok(buildPnl("today", EMPTY, null).text.includes("?"));
});

test("buildRecent lists the last 10 closes newest first with a Metlex url button", () => {
  const trades = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    pair: "AAA-SOL",
    closedAt: 1_000_000 + i,
    closeReason: "tp",
    closePnlUsd: 1.5,
    closePnlPct: 3,
    closeTx: i === 11 ? "TxSig<1>" : null,
  }));
  const { text, keyboard } = buildRecent(trades);
  assert.ok(text.indexOf("#12") < text.indexOf("#11"));
  assert.ok(text.includes("#3 "));
  assert.ok(!text.includes("#2 "));
  assert.ok(text.includes("+3.00% ($1.50)"));
  assert.ok(text.includes("Take Profit"));
  assert.ok(text.includes("<code>TxSig&lt;1&gt;</code>"));
  assert.ok(text.includes("no tx"));
  const urls = buttons(keyboard).filter((b) => b.url);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, "https://www.metlex.io/pnl-cards");
  assert.equal(urls[0].text, "🖼 Open Metlex");
});

test("buildRecent with no closes says so", () => {
  assert.ok(buildRecent([]).text.includes("No closed trades"));
});

function build() {
  const bot = createBot({ token: "123:dummy", chatId: String(OWNER), modules: [startModule, pnlModule] });
  const calls = [];
  const flags = { failEdit: false };
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    if (method === "editMessageText" && flags.failEdit) {
      return { ok: false, error_code: 400, description: "Bad Request: message cannot be edited" };
    }
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" } } };
  });
  bot.botInfo = BOT_INFO;
  return { bot, calls, flags };
}

let updateId = 100;
const cbUpdate = (data) => ({
  update_id: updateId++,
  callback_query: {
    id: `q${updateId}`,
    from: { id: OWNER, is_bot: false, first_name: "U" },
    chat_instance: "c",
    data,
    message: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" }, text: "x" },
  },
});
const cmdUpdate = (text) => ({
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

// Trade tertutup baru saja (masuk periode today/week/month).
function closedNow(extra = {}) {
  const t = createTrade({
    pool: "PoolA",
    pair: "BONK-SOL",
    baseMint: "MintA",
    positions: ["PosA"],
    shape: "spot",
    depositSol: 0.5,
    origin: "manual",
  });
  const state = readState();
  Object.assign(state.trades[String(t.id)], {
    closed: true,
    closedAt: Date.now(),
    closeReason: "tp",
    closePnlUsd: 4,
    closePnlPct: 8,
    closeTx: "SigAbc",
    ...extra,
  });
  writeState(state);
  return t;
}

test("home:pnl and /pnl reply with the today screen", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("home:pnl"));
  await bot.handleUpdate(cmdUpdate("/pnl"));
  const sends = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sends.length, 2);
  for (const s of sends) {
    assert.equal(s.payload.parse_mode, "HTML");
    assert.ok(s.payload.text.includes("Today"));
    assert.ok(!s.payload.text.includes("Coming soon"));
  }
});

test("tab buttons edit the message in place and include closed trades", async () => {
  closedNow();
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("pnl:month"));
  const edit = calls.find((c) => c.method === "editMessageText");
  assert.ok(edit);
  assert.ok(edit.payload.text.includes("This month"));
  assert.ok(edit.payload.text.includes("$4.00"));
  assert.ok(!calls.some((c) => c.method === "sendMessage"));
});

test("a failed edit falls back to a reply", async () => {
  const { bot, calls, flags } = build();
  flags.failEdit = true;
  await bot.handleUpdate(cbUpdate("pnl:week"));
  assert.ok(calls.some((c) => c.method === "sendMessage" && c.payload.text.includes("This week")));
});

test("recent view shows closes with their tx and the Metlex button", async () => {
  closedNow();
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("pnl:recent"));
  const edit = calls.find((c) => c.method === "editMessageText");
  assert.ok(edit.payload.text.includes("<code>SigAbc</code>"));
  assert.ok(buttons(edit.payload).some((b) => b.url === "https://www.metlex.io/pnl-cards"));
});

test("partial open PnL reaches the screen", async () => {
  deps.summarizeOpenTrades = async () => ({ count: 2, pnlUsd: 3, partial: true });
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("pnl:today"));
  assert.ok(calls.find((c) => c.method === "editMessageText").payload.text.includes("(partial)"));
});
