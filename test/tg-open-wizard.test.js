import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// File state/settings diarahkan ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tg-open-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { createBot } = await import("../src/tg/bot.js");
const wizardModule = await import("../src/tg/open-wizard.js");
const session = await import("../src/tg/session.js");

const { buildConfirm, buildPoolCard, deps } = wizardModule;
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
const MINT_ADDR = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const EXIT = {
  tp: { on: true, pct: 15 },
  sl: { on: true, pct: 25 },
  trail: { on: true, startPct: 5, distancePct: 3 },
};
const EXIT_OFF = {
  tp: { on: false, pct: 15 },
  sl: { on: false, pct: 25 },
  trail: { on: false, startPct: 5, distancePct: 3 },
};
const PLAN = {
  poolAddress: POOL_ADDR,
  pair: "BONK-SOL",
  depositSol: 0.5,
  below: 45,
  above: 45,
  shape: "spot",
  binCount: 60,
  positionCount: 1,
  swapSol: 0.25,
  solSideSol: 0.25,
  rentSol: 0.057,
  extraRentSol: 0,
  lowSol: 0.000012,
  highSol: 0.00003,
  solOnly: false,
};

let executed = [];
let failEditContaining = null;

test.beforeEach(() => {
  Object.assign(deps, ORIGINAL_DEPS);
  executed = [];
  failEditContaining = null;
  deps.resolveAddress = async () => ({ type: "pool", pool: { address: POOL_ADDR, name: "BONK-SOL", baseMint: "M" } });
  deps.planOpen = async (args) => ({ ...PLAN, ...args });
  deps.executeOpen = async (plan, { onProgress }) => {
    executed.push(plan);
    await onProgress("Swapping…");
    return { success: true, trade: { id: 7 } };
  };
  deps.getExitPreset = () => EXIT;
  session.del("wizard");
  session.del("prompt");
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function build() {
  const bot = createBot({ token: "123:dummy", chatId: String(OWNER), modules: [wizardModule] });
  const calls = [];
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    if (method === "editMessageText" && failEditContaining && payload.text.includes(failEditContaining)) {
      throw new Error("Bad Request: message can't be edited");
    }
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: OWNER, type: "private" } } };
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
    entities: text.startsWith("/")
      ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }]
      : undefined,
  },
});

const texts = (calls) =>
  calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map((c) => c.payload.text);
const lastMarkup = (calls) =>
  [...calls]
    .reverse()
    .find((c) => c.payload.reply_markup)
    ?.payload.reply_markup.inline_keyboard.flat() ?? [];
const lastData = (calls) => lastMarkup(calls).map((b) => b.callback_data);

test("pasting a pool goes to deposit buttons", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  assert.deepEqual(lastData(calls), [
    "op:dep:0.5",
    "op:dep:0.7",
    "op:dep:0.9",
    "op:dep:1",
    "op:dep:custom",
    "op:cancel",
  ]);
  assert.equal(session.get("wizard").poolAddress, POOL_ADDR);
});

test("pasting a mint offers its pools and picking one goes to deposit", async () => {
  deps.resolveAddress = async () => ({
    type: "mint",
    pools: [
      { address: "PoolA", name: "BONK-SOL", binStep: 20, baseFeePct: 0.2, tvlUsd: 1200000, volume24hUsd: 5000 },
      { address: "PoolB", name: "BONK-SOL", binStep: 80, baseFeePct: 1, tvlUsd: 3000, volume24hUsd: 100 },
    ],
  });
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate(MINT_ADDR));
  assert.deepEqual(lastData(calls), ["op:pool:0", "op:pool:1", "op:cancel"]);
  await bot.handleUpdate(cbUpdate("op:pool:1"));
  assert.equal(session.get("wizard").poolAddress, "PoolB");
  assert.equal(lastData(calls)[0], "op:dep:0.5");
  assert.ok(texts(calls).at(-1).includes("80"));
});

test("resolve outcomes and errors reply without crashing", async () => {
  const { bot, calls } = build();
  deps.resolveAddress = async () => ({ type: "invalid", reason: "x" });
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  deps.resolveAddress = async () => ({ type: "not_sol", pair: "A-B" });
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  deps.resolveAddress = async () => {
    throw new Error("rpc down\nstack line");
  };
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  assert.deepEqual(texts(calls), [
    "Not a DLMM pool or token with a SOL pool.",
    "Only SOL pairs are supported (A-B).",
    "Couldn't look up that address: rpc down",
  ]);
});

test("/open prompts for an address and the next text starts the wizard", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate("/open"));
  assert.deepEqual(texts(calls), ["Send a pool address or token mint"]);
  assert.equal(session.get("prompt").kind, "open-address");
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  assert.equal(session.get("prompt"), null);
  assert.equal(lastData(calls)[0], "op:dep:0.5");
});

test("custom deposit parses", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:dep:custom"));
  assert.equal(session.get("prompt").kind, "open-deposit");
  await bot.handleUpdate(textUpdate("0,3"));
  assert.equal(session.get("wizard").depositSol, 0.3);
  assert.ok(lastData(calls).includes("op:rng:balanced"));
  assert.ok(lastData(calls).includes("op:rng:custom"));
});

test("invalid custom deposit keeps the prompt", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:dep:custom"));
  await bot.handleUpdate(textUpdate("abc"));
  assert.equal(texts(calls).at(-1), "Invalid amount, try again");
  assert.equal(session.get("prompt").kind, "open-deposit");
  assert.equal(session.get("wizard").depositSol, undefined);
});

test('custom range "45" is SOL only', async () => {
  const { bot } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:dep:1"));
  await bot.handleUpdate(cbUpdate("op:rng:custom"));
  await bot.handleUpdate(textUpdate("45"));
  const w = session.get("wizard");
  assert.equal(w.below, 45);
  assert.equal(w.above, 0);
  assert.equal(w.step, "shape");
});

test("preset range then shape plans and shows the confirm card", async () => {
  let planArgs = null;
  deps.planOpen = async (args) => {
    planArgs = args;
    return { ...PLAN, ...args };
  };
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:dep:0.5"));
  await bot.handleUpdate(cbUpdate("op:rng:balanced_sol"));
  assert.deepEqual(
    lastData(calls).filter((d) => d.startsWith("op:shp:")),
    ["op:shp:spot", "op:shp:curve", "op:shp:bid_ask", "op:shp:mixed"]
  );
  await bot.handleUpdate(cbUpdate("op:shp:mixed"));
  assert.deepEqual(planArgs, { poolAddress: POOL_ADDR, depositSol: 0.5, below: 45, above: 0, shape: "mixed" });
  const data = lastData(calls);
  assert.ok(data.some((d) => d.startsWith("ok:")));
  assert.ok(data.includes("op:back"));
  assert.ok(data.includes("op:cancel"));
  assert.ok(session.get("wizard").plan);
});

test("plan error is shown instead of the confirm card", async () => {
  deps.planOpen = async () => ({ error: "Not enough SOL: need 0.58, have 0.1 (short 0.48)" });
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:dep:0.5"));
  await bot.handleUpdate(cbUpdate("op:rng:balanced"));
  await bot.handleUpdate(cbUpdate("op:shp:spot"));
  assert.ok(texts(calls).at(-1).includes("Not enough SOL"));
  assert.ok(!lastData(calls).some((d) => d.startsWith("ok:")));
  await bot.handleUpdate(cbUpdate("op:back"));
  assert.equal(session.get("wizard").step, "shape");
});

test("plan throw is reported with its first line", async () => {
  deps.planOpen = async () => {
    throw new Error("boom\nmore");
  };
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:dep:0.5"));
  await bot.handleUpdate(cbUpdate("op:rng:balanced"));
  await bot.handleUpdate(cbUpdate("op:shp:spot"));
  assert.ok(texts(calls).at(-1).includes("Couldn't plan this position: boom"));
  assert.ok(!texts(calls).at(-1).includes("more"));
});

test("op:back goes one step back", async () => {
  const { bot } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:dep:0.5"));
  await bot.handleUpdate(cbUpdate("op:rng:balanced"));
  assert.equal(session.get("wizard").step, "shape");
  await bot.handleUpdate(cbUpdate("op:back"));
  assert.equal(session.get("wizard").step, "range");
  await bot.handleUpdate(cbUpdate("op:back"));
  assert.equal(session.get("wizard").step, "deposit");
});

test("cancel clears the wizard", async () => {
  const { bot } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:cancel"));
  assert.equal(session.get("wizard"), null);
});

test("buildPoolCard shows the fields it has", () => {
  const full = buildPoolCard({ name: "BONK-SOL", binStep: 20, baseFeePct: 0.2, tvlUsd: 1200000, priceSol: 0.00002 });
  assert.ok(full.includes("BONK-SOL"));
  assert.ok(full.includes("20"));
  assert.ok(full.includes("0.2%"));
  assert.ok(full.includes("$1,200,000"));
  const minimal = buildPoolCard({ name: "BONK-SOL" });
  assert.ok(minimal.includes("BONK-SOL"));
  assert.ok(!minimal.includes("TVL"));
  assert.ok(!minimal.includes("undefined"));
});

test("buildConfirm shows SOL only", () => {
  const text = buildConfirm({ ...PLAN, above: 0, solOnly: true, swapSol: 0 }, EXIT);
  assert.ok(text.includes("SOL only"));
  assert.ok(!text.includes("→ token"));
  assert.ok(text.includes("−45% / +0%"));
});

test("buildConfirm shows rent and exits", () => {
  const text = buildConfirm(PLAN, EXIT);
  assert.ok(text.includes("Swap: 0.25 SOL → token"));
  assert.ok(text.includes("Rent (refundable): 0.057 SOL"));
  assert.ok(text.includes("TP15 SL-25 T5/3"));
  assert.ok(text.includes("−45% / +45%"));
  assert.ok(text.includes("60 bins"));
  assert.ok(buildConfirm(PLAN, EXIT_OFF).includes("Auto Exit off"));
});

async function toConfirm(bot, calls) {
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:dep:0.5"));
  await bot.handleUpdate(cbUpdate("op:rng:balanced"));
  await bot.handleUpdate(cbUpdate("op:shp:spot"));
  return lastMarkup(calls).find((b) => b.callback_data?.startsWith("ok:")).callback_data;
}

test("refresh re-plans the confirm card with a new token", async () => {
  let plans = 0;
  deps.planOpen = async (args) => ({ ...PLAN, ...args, lowSol: 0.000012 * ++plans });
  const { bot, calls } = build();
  const first = await toConfirm(bot, calls);
  assert.ok(lastData(calls).includes("op:refresh"));
  await bot.handleUpdate(cbUpdate("op:refresh"));
  assert.equal(plans, 2);
  const second = lastData(calls).find((d) => d.startsWith("ok:"));
  assert.ok(second && second !== first);
  assert.ok(texts(calls).at(-1).includes("0.000024"));
  await bot.handleUpdate(cbUpdate(second));
  assert.equal(executed.length, 1);
  assert.equal(executed[0].lowSol, 0.000024);
});

test("refresh outside the confirm step does nothing", async () => {
  let plans = 0;
  deps.planOpen = async (args) => {
    plans++;
    return { ...PLAN, ...args };
  };
  const { bot } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:refresh"));
  assert.equal(plans, 0);
  assert.equal(session.get("wizard").step, "deposit");
});

test("confirm token is one-shot", async () => {
  const { bot, calls } = build();
  const token = await toConfirm(bot, calls);
  await bot.handleUpdate(cbUpdate(token));
  await bot.handleUpdate(cbUpdate(token));
  assert.equal(executed.length, 1);
  assert.equal(executed[0].pair, "BONK-SOL");
  assert.ok(texts(calls).some((t) => t.includes("✅ Opened #7")));
  assert.ok(lastData(calls).includes("pos:open:7"));
});

test("confirm shows the warning, the failure and the dry run", async () => {
  const { bot, calls } = build();
  deps.executeOpen = async () => ({ success: true, trade: { id: 9 }, warning: "Spot layer failed" });
  await bot.handleUpdate(cbUpdate(await toConfirm(bot, calls)));
  assert.ok(texts(calls).at(-1).includes("⚠️ Spot layer failed"));

  deps.executeOpen = async () => ({ success: false, error: "swap failed: x" });
  await bot.handleUpdate(cbUpdate(await toConfirm(bot, calls)));
  assert.ok(texts(calls).at(-1).includes("swap failed: x"));

  deps.executeOpen = async () => ({ success: true, dryRun: true });
  await bot.handleUpdate(cbUpdate(await toConfirm(bot, calls)));
  const last = texts(calls).at(-1);
  assert.ok(last.includes("🧪 Dry run — nothing was sent."));
  assert.ok(last.includes("BONK-SOL"));
});

test("expired wizard", async () => {
  const { bot, calls } = build();
  session.del("wizard");
  await bot.handleUpdate(cbUpdate("op:shp:spot"));
  assert.ok(texts(calls).some((t) => t.includes("expired")));
});

test("result edit failing still delivers the success message by reply", async () => {
  const { bot, calls } = build();
  const token = await toConfirm(bot, calls);
  failEditContaining = "Opened";
  await bot.handleUpdate(cbUpdate(token));
  assert.equal(executed.length, 1);
  const sentTexts = calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text);
  assert.ok(sentTexts.some((t) => t.includes("✅ Opened #7")));
  assert.ok(!sentTexts.some((t) => t.includes("Confirm failed")));
  const reply = calls.filter((c) => c.method === "sendMessage").at(-1);
  assert.ok(reply.payload.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "pos:open:7"));
});

test("a shape tap with no range re-shows the range step and never plans", async () => {
  let planned = 0;
  deps.planOpen = async () => void planned++;
  session.put("wizard", { id: 99, step: "range", poolAddress: POOL_ADDR, pool: { name: "BONK-SOL" }, depositSol: 0.5 });
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("op:shp:spot"));
  assert.equal(planned, 0);
  assert.ok(lastData(calls).includes("op:rng:balanced"));
  assert.equal(session.get("wizard").step, "range");
});

test("a shape tap with no deposit re-shows the deposit step", async () => {
  let planned = 0;
  deps.planOpen = async () => void planned++;
  session.put("wizard", { id: 99, step: "deposit", poolAddress: POOL_ADDR, pool: { name: "BONK-SOL" } });
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("op:shp:curve"));
  assert.equal(planned, 0);
  assert.equal(lastData(calls)[0], "op:dep:0.5");
});

test("a range tap with no deposit re-shows the deposit step", async () => {
  session.put("wizard", { id: 99, step: "deposit", poolAddress: POOL_ADDR, pool: { name: "BONK-SOL" } });
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("op:rng:balanced"));
  assert.equal(lastData(calls)[0], "op:dep:0.5");
  assert.equal(session.get("wizard").below, undefined);
});

test("confirming an old token does not delete a newer wizard", async () => {
  const { bot, calls } = build();
  const token = await toConfirm(bot, calls);
  await bot.handleUpdate(textUpdate(POOL_ADDR)); // wizard baru
  const newer = session.get("wizard");
  assert.equal(newer.step, "deposit");
  assert.ok(newer.id);
  await bot.handleUpdate(cbUpdate(token));
  assert.equal(executed.length, 1);
  assert.equal(session.get("wizard")?.id, newer.id);
});

test("the default shape button is labelled spot ✓ with unchanged data", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:dep:0.5"));
  await bot.handleUpdate(cbUpdate("op:rng:balanced"));
  const spot = lastMarkup(calls).find((b) => b.callback_data === "op:shp:spot");
  assert.equal(spot.text, "spot ✓");
});

const presetsMod = await import("../src/state/settings.js");

test("range buttons show the range of each preset", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate(POOL_ADDR));
  await bot.handleUpdate(cbUpdate("op:dep:0.5"));
  const labels = lastMarkup(calls).map((b) => b.text);
  assert.ok(labels.includes("Narrow (−20%/+20%)"));
  assert.ok(labels.includes("Balanced (−45%/+45%)"));
  assert.ok(labels.includes("Wide SOL (−65%)"));
});

test("edited range preset is shown and used", async () => {
  presetsMod.setRangePreset("balanced", { below: 30, above: 10 });
  try {
    const { bot, calls } = build();
    await bot.handleUpdate(textUpdate(POOL_ADDR));
    await bot.handleUpdate(cbUpdate("op:dep:0.5"));
    assert.ok(lastMarkup(calls).some((b) => b.text === "Balanced (−30%/+10%)"));
    await bot.handleUpdate(cbUpdate("op:rng:balanced"));
    assert.equal(session.get("wizard").below, 30);
    assert.equal(session.get("wizard").above, 10);
  } finally {
    presetsMod.resetRangePresets();
  }
});

test("deposit buttons come from the deposit presets", async () => {
  presetsMod.setDepositPresets([0.3, 0.5, 1, 2]);
  try {
    const { bot, calls } = build();
    await bot.handleUpdate(textUpdate(POOL_ADDR));
    assert.deepEqual(lastData(calls), [
      "op:dep:0.3",
      "op:dep:0.5",
      "op:dep:1",
      "op:dep:2",
      "op:dep:custom",
      "op:cancel",
    ]);
    await bot.handleUpdate(cbUpdate("op:dep:2"));
    assert.equal(session.get("wizard").depositSol, 2);
  } finally {
    presetsMod.resetDepositPresets();
  }
});
