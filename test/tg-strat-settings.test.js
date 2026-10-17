import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// strat.conf / settings / state sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tg-strat-"));
const STRAT = path.join(TMP, "strat.conf");
const EXTRA = Array.from({ length: 8 }, (_, i) => `EXTRA_${i}_SEC=${i}`);
fs.writeFileSync(
  STRAT,
  [
    "SOL_MODE=false",
    "SWEEP_EXCLUDE_MINTS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "",
    "# ===== Entry =====",
    "# Share of the deposit kept as SOL",
    "ENTRY_SIZE_SPLIT=0.5",
    "TRADE_EXIT_INTERVAL_SEC=1",
    ...EXTRA,
    "ENTRY_FEE_MODE=none",
    "",
  ].join("\n")
);
process.env.STRAT_FILE = STRAT;
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");
process.env.STATE_FILE = path.join(TMP, "state.json");

const { createBot } = await import("../src/tg/bot.js");
const settingsModule = await import("../src/tg/settings.js");
const session = await import("../src/tg/session.js");
const { getStratOverrides, setStratOverride } = await import("../src/state/settings.js");
const { parseStratText } = await import("../src/config/strat-schema.js");
const { buildStratSection } = await import("../src/tg/strat-settings.js");

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

let updateId = 10;
const cbUpdate = (data) => ({
  update_id: updateId++,
  callback_query: {
    id: `q${updateId}`,
    from: { id: OWNER, is_bot: false, first_name: "U" },
    chat_instance: "c",
    data,
    message: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" }, text: "hi" },
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
    entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.length }] : undefined,
  },
});

const sent = (calls) =>
  calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map((c) => c.payload);
const lastText = (calls) => sent(calls).at(-1)?.text ?? "";
const lastButtons = (calls) => sent(calls).at(-1)?.reply_markup?.inline_keyboard.flat() ?? [];
const lastData = (calls) => lastButtons(calls).map((b) => b.callback_data);

test("/settings links to the Strategy menu and home lists the sections", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate("/settings"));
  assert.ok(lastData(calls).includes("st:home"));
  await bot.handleUpdate(cbUpdate("st:home"));
  const labels = lastButtons(calls).map((b) => b.text);
  assert.ok(labels.some((l) => l.startsWith("General")));
  assert.ok(labels.some((l) => l.startsWith("Entry")));
  assert.ok(lastData(calls).includes("st:s:1:0"));
});

test("sections page 8 keys at a time", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("st:s:1:0"));
  const keys0 = lastData(calls).filter((d) => d.startsWith("st:k:"));
  assert.equal(keys0.length, 8);
  assert.ok(lastData(calls).includes("st:s:1:1"));
  await bot.handleUpdate(cbUpdate("st:s:1:1"));
  const keys1 = lastData(calls).filter((d) => d.startsWith("st:k:"));
  assert.equal(keys1.length, 3);
  assert.ok(lastData(calls).includes("st:s:1:0"));
});

test("bool keys toggle from the card and reset back to default", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("st:k:SOL_MODE"));
  assert.ok(lastData(calls).includes("st:set:SOL_MODE:true"));
  await bot.handleUpdate(cbUpdate("st:set:SOL_MODE:true"));
  assert.deepEqual(getStratOverrides(), { SOL_MODE: "true" });
  assert.match(lastText(calls), /✏️ override/);
  assert.ok(lastData(calls).includes("st:reset:SOL_MODE"));
  await bot.handleUpdate(cbUpdate("st:reset:SOL_MODE"));
  assert.deepEqual(getStratOverrides(), {});
  assert.match(lastText(calls), /default/);
});

test("enum keys offer their options and reject others", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("st:k:ENTRY_FEE_MODE"));
  for (const opt of ["none", "priority", "jito", "both"]) {
    assert.ok(lastData(calls).includes(`st:set:ENTRY_FEE_MODE:${opt}`), opt);
  }
  await bot.handleUpdate(cbUpdate("st:set:ENTRY_FEE_MODE:jito"));
  assert.deepEqual(getStratOverrides(), { ENTRY_FEE_MODE: "jito" });
  await bot.handleUpdate(cbUpdate("st:set:ENTRY_FEE_MODE:fast"));
  assert.deepEqual(getStratOverrides(), { ENTRY_FEE_MODE: "jito" });
  assert.match(lastText(calls), /must be one of/);
});

test("number keys are edited through a prompt with validation", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("st:edit:ENTRY_SIZE_SPLIT"));
  assert.deepEqual(session.get("prompt"), { kind: "strat-edit", key: "ENTRY_SIZE_SPLIT" });
  assert.match(lastText(calls), /between 0 and 1/);
  await bot.handleUpdate(textUpdate("0,5"));
  assert.match(lastText(calls), /must be a number between 0 and 1/);
  assert.equal(session.get("prompt")?.kind, "strat-edit");
  await bot.handleUpdate(textUpdate("0.3"));
  assert.deepEqual(getStratOverrides(), { ENTRY_SIZE_SPLIT: "0.3" });
  assert.equal(session.get("prompt"), null);
  assert.match(lastText(calls), /Share of the deposit kept as SOL/);
});

test("restart keys say they apply after restart and are marked in the list", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("st:edit:TRADE_EXIT_INTERVAL_SEC"));
  await bot.handleUpdate(textUpdate("2"));
  assert.match(lastText(calls), /applies after restart/);
  await bot.handleUpdate(cbUpdate("st:s:1:0"));
  const label = lastButtons(calls).find((b) => b.callback_data === "st:k:TRADE_EXIT_INTERVAL_SEC").text;
  assert.ok(label.includes("⟳"), label);
  assert.ok(label.includes("✏️"), label);
});

test("reset all asks for confirmation first", async () => {
  setStratOverride("SOL_MODE", "true");
  setStratOverride("ENTRY_SIZE_SPLIT", "0.2");
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("st:resetall"));
  assert.ok(lastData(calls).includes("st:resetall:yes"));
  assert.equal(Object.keys(getStratOverrides()).length, 2);
  await bot.handleUpdate(cbUpdate("st:resetall:yes"));
  assert.deepEqual(getStratOverrides(), {});
});

test("a key no longer in strat.conf answers without crashing", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("st:k:GONE_KEY"));
  assert.equal(lastText(calls), "GONE_KEY is no longer in strat.conf.");
});

test("every callback on every screen fits Telegram's 64-byte limit", async () => {
  const { bot, calls } = build();
  const seen = new Set();
  const queue = ["st:home"];
  while (queue.length) {
    const data = queue.shift();
    if (seen.has(data) || !data.startsWith("st:") || data.startsWith("st:set:") || data.startsWith("st:reset"))
      continue;
    seen.add(data);
    await bot.handleUpdate(cbUpdate(data));
    for (const d of lastData(calls)) {
      assert.ok(Buffer.byteLength(d) <= 64, d);
      queue.push(d);
    }
    session.del("prompt");
  }
  assert.ok(seen.size > 10);
});

test("list keys accept pasted mint addresses in the edit prompt", async () => {
  const { bot } = build();
  await bot.handleUpdate(cbUpdate("st:edit:SWEEP_EXCLUDE_MINTS"));
  await bot.handleUpdate(
    textUpdate("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, So11111111111111111111111111111111111111112")
  );
  assert.deepEqual(getStratOverrides(), {
    SWEEP_EXCLUDE_MINTS: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,So11111111111111111111111111111111111111112",
  });
  assert.equal(session.get("prompt"), null);
});

test("Exit strategy sections go back to the Exit strategy screen", () => {
  const schema = parseStratText(
    ["# ===== Entry =====", "A_SEC=1", "", "# ===== Exit strategy · Evil Panda =====", "EVIL_PANDA_RSI=true"].join("\n")
  );
  const back = (i) => buildStratSection(schema, {}, i, 0).keyboard.inline_keyboard.flat().at(-1);
  assert.deepEqual([back(0).text, back(0).callback_data], ["⬅ Sections", "st:home"]);
  assert.deepEqual([back(1).text, back(1).callback_data], ["⬅ Exit strategy", "set:exit"]);
});
