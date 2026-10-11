import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// File state/settings/kunci diarahkan ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tg-wallet-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");
process.env.WALLET_KEY_FILE = path.join(TMP, "wallet.key");

const { createBot } = await import("../src/tg/bot.js");
const walletModule = await import("../src/tg/wallet.js");
const session = await import("../src/tg/session.js");
const walletLib = await import("../src/solana/wallet.js");
const { createTrade } = await import("../src/state/trades.js");

const { buildWallet, deps } = walletModule;
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
const KEY_FILE = process.env.WALLET_KEY_FILE;
const CURRENT = Keypair.generate();
const DEST = Keypair.generate().publicKey.toBase58();

let failDelete = false;
let sentWithdraws = [];
let balanceSol = 2;

let logLines = [];

test.beforeEach((t) => {
  // Log bot ditangkap supaya output tes bersih dan bisa diperiksa.
  logLines = [];
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    t.mock.method(console, m, (...a) => void logLines.push(a.join(" ")));
  }
  Object.assign(deps, ORIGINAL_DEPS);
  fs.rmSync(process.env.STATE_FILE, { force: true });
  fs.rmSync(KEY_FILE, { force: true });
  walletLib.saveWalletKey(CURRENT);
  walletLib.reloadWallet();
  session.del("prompt");
  failDelete = false;
  sentWithdraws = [];
  balanceSol = 2;
  deps.getBalances = async () => ({ sol: 1.5, tokens: [{ mint: "M", balance: 1234.5678912, usd: 5, symbol: "BONK" }] });
  deps.getSolUsd = async () => 100;
  deps.getSolBalance = async () => balanceSol;
  deps.isDryRun = () => false;
  deps.withdrawSol = async (args) => {
    sentWithdraws.push(args);
    return { success: true, tx: "TXSIG" };
  };
});

test.after(() => {
  walletLib.reloadWallet();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function build() {
  const bot = createBot({ token: "123:dummy", chatId: String(OWNER), modules: [walletModule] });
  const calls = [];
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    if (method === "deleteMessage" && failDelete) throw new Error("Bad Request: message can't be deleted");
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
const tokenOf = (calls, label) =>
  lastMarkup(calls)
    .find((b) => b.text === label)
    .callback_data.slice(3);
const OPEN_TRADE = { pool: "P", pair: "A-SOL", baseMint: "M", positions: ["Pos"], origin: "manual", exit: {} };

// ---- Kartu ----

test("buildWallet shows address, balance, tokens and the four buttons", () => {
  const { text, keyboard } = buildWallet({
    address: "Addr1",
    sol: 1.5,
    solUsd: 100,
    tokens: [{ mint: "M", balance: 10, usd: 5, symbol: "BONK" }],
  });
  assert.ok(text.includes("<code>Addr1</code>"));
  assert.ok(text.includes("1.5 SOL"));
  assert.ok(text.includes("$150.00"));
  assert.ok(text.includes("BONK"));
  assert.deepEqual(
    keyboard.inline_keyboard.map((row) => row.map((b) => [b.text, b.callback_data])),
    [
      [
        ["📥 Deposit", "wal:dep"],
        ["📤 Withdraw", "wal:wd"],
      ],
      [
        ["🔑 Export", "wal:exp"],
        ["📲 Import", "wal:imp"],
      ],
    ]
  );
});

test("buildWallet tolerates missing data", () => {
  const { text } = buildWallet({ address: null, sol: null, solUsd: null });
  assert.ok(text.includes("?"));
});

test("home:wallet and /wallet show the wallet card", async () => {
  for (const update of [cbUpdate("home:wallet"), textUpdate("/wallet")]) {
    const { bot, calls } = build();
    await bot.handleUpdate(update);
    assert.ok(texts(calls).at(-1).includes(CURRENT.publicKey.toBase58()));
    assert.ok(!texts(calls).includes("Coming soon"));
    assert.deepEqual(
      lastMarkup(calls).map((b) => b.callback_data),
      ["wal:dep", "wal:wd", "wal:exp", "wal:imp"]
    );
  }
});

test("deposit shows the address as tap-to-copy", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:dep"));
  const sent = calls.find((c) => c.method === "sendMessage").payload;
  assert.ok(sent.text.includes(`<code>${CURRENT.publicKey.toBase58()}</code>`));
  assert.equal(sent.parse_mode, "HTML");
});

// ---- Import ----

test("import deletes the user message before anything else", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:imp"));
  assert.equal(session.get("prompt").kind, "wallet-import");
  calls.length = 0;
  const fresh = Keypair.generate();
  await bot.handleUpdate(textUpdate(bs58.encode(fresh.secretKey)));
  assert.equal(calls[0].method, "deleteMessage");
  assert.equal(calls[0].payload.message_id, 5);
  // Kunci 64 byte sampai ke prompt walau router mengabaikan run > 44 karakter.
  assert.equal(walletLib.getWallet().publicKey.toBase58(), fresh.publicKey.toBase58());
  assert.ok(texts(calls).at(-1).includes(fresh.publicKey.toBase58()));
  assert.equal(fs.readFileSync(KEY_FILE, "utf8").trim(), bs58.encode(fresh.secretKey));
  assert.equal(session.get("prompt"), null);
});

test("import accepts a JSON array key", async () => {
  const { bot } = build();
  await bot.handleUpdate(cbUpdate("wal:imp"));
  const fresh = Keypair.generate();
  await bot.handleUpdate(textUpdate(JSON.stringify(Array.from(fresh.secretKey))));
  assert.equal(walletLib.getWallet().publicKey.toBase58(), fresh.publicKey.toBase58());
});

test("import refused with open trades: no prompt, nothing changed", async () => {
  createTrade(OPEN_TRADE);
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:imp"));
  assert.equal(session.get("prompt"), null);
  assert.ok(texts(calls).at(-1).includes("Close all trades first"));
});

test("a trade opened while the prompt waits still blocks the import", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:imp"));
  createTrade(OPEN_TRADE);
  await bot.handleUpdate(textUpdate(bs58.encode(Keypair.generate().secretKey)));
  assert.ok(texts(calls).at(-1).includes("Close all trades first"));
  assert.equal(walletLib.getWallet().publicKey.toBase58(), CURRENT.publicKey.toBase58());
});

test("invalid key replies Invalid key without echoing the input", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:imp"));
  calls.length = 0;
  const junk = "x".repeat(80);
  await bot.handleUpdate(textUpdate(junk));
  assert.equal(calls[0].method, "deleteMessage");
  const reply = texts(calls).at(-1);
  assert.ok(reply.includes("Invalid key"));
  assert.ok(!reply.includes(junk));
  assert.equal(walletLib.getWallet().publicKey.toBase58(), CURRENT.publicKey.toBase58());
});

test("importing the active wallet is refused", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:imp"));
  await bot.handleUpdate(textUpdate(bs58.encode(CURRENT.secretKey)));
  assert.ok(texts(calls).at(-1).includes("That's already the active wallet"));
});

test("import warns when the key message could not be deleted but still continues", async () => {
  failDelete = true;
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:imp"));
  const fresh = Keypair.generate();
  await bot.handleUpdate(textUpdate(bs58.encode(fresh.secretKey)));
  assert.ok(texts(calls).includes("Couldn't delete your message — delete it manually now."));
  assert.equal(walletLib.getWallet().publicKey.toBase58(), fresh.publicKey.toBase58());
});

test("import never writes the secret key to the console or to replies", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:imp"));
  const fresh = Keypair.generate();
  const secret = bs58.encode(fresh.secretKey);
  await bot.handleUpdate(textUpdate(secret));
  assert.ok(logLines.some((l) => l.includes(`wallet imported: ${fresh.publicKey.toBase58()}`)));
  assert.ok(!logLines.some((l) => l.includes(secret)));
  assert.ok(!texts(calls).some((x) => x.includes(secret)));
});

// ---- Export ----

test("export needs I understand, sends the key in <code>, then deletes it after 60 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const secret = bs58.encode(CURRENT.secretKey);
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:exp"));
  assert.ok(!texts(calls).some((x) => x.includes(secret)));
  assert.deepEqual(
    lastMarkup(calls).map((b) => b.text),
    ["I understand", "✖ Cancel"]
  );
  await bot.handleUpdate(cbUpdate(`ok:${tokenOf(calls, "I understand")}`));
  const keyMsg = calls.find((c) => c.method === "sendMessage" && c.payload.text.includes(secret));
  assert.ok(keyMsg);
  assert.equal(keyMsg.payload.parse_mode, "HTML");
  assert.ok(keyMsg.payload.text.includes(`<code>${secret}</code>`));
  assert.ok(!calls.some((c) => c.method === "deleteMessage"));
  t.mock.timers.tick(59999);
  assert.ok(!calls.some((c) => c.method === "deleteMessage"));
  t.mock.timers.tick(1);
  await new Promise((r) => setImmediate(r));
  const del = calls.find((c) => c.method === "deleteMessage");
  assert.ok(del);
  assert.equal(del.payload.message_id, 77);
  assert.equal(del.payload.chat_id, OWNER);
});

test("export tells the user when auto-delete fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:exp"));
  await bot.handleUpdate(cbUpdate(`ok:${tokenOf(calls, "I understand")}`));
  failDelete = true;
  t.mock.timers.tick(60000);
  await new Promise((r) => setImmediate(r));
  assert.ok(texts(calls).includes("Couldn't auto-delete the key message — delete it manually."));
});

test("export cancel voids the confirm token", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const secret = bs58.encode(CURRENT.secretKey);
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:exp"));
  const token = tokenOf(calls, "I understand");
  await bot.handleUpdate(cbUpdate(`wal:x:${token}`));
  await bot.handleUpdate(cbUpdate(`ok:${token}`));
  assert.ok(!texts(calls).some((x) => x.includes(secret)));
  assert.ok(calls.some((c) => c.method === "answerCallbackQuery" && c.payload.show_alert));
});

// ---- Withdraw ----

test("withdraw flow: address, amount, confirm shows full address and amount, then sends", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  assert.equal(session.get("prompt").kind, "wallet-withdraw-address");
  await bot.handleUpdate(textUpdate(DEST));
  assert.equal(session.get("prompt").kind, "wallet-withdraw-amount");
  await bot.handleUpdate(textUpdate("0.5"));
  const confirm = texts(calls).at(-1);
  assert.ok(confirm.includes(DEST));
  assert.ok(confirm.includes("0.5 SOL"));
  assert.ok(!confirm.includes("DRY RUN"));
  await bot.handleUpdate(cbUpdate(`ok:${tokenOf(calls, "✅ Confirm")}`));
  assert.deepEqual(sentWithdraws, [{ to: DEST, amountSol: 0.5 }]);
  const done = texts(calls).at(-1);
  assert.ok(done.includes("TXSIG") && done.includes(DEST));
});

test("withdraw max sends balance minus 0.01", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate(DEST));
  await bot.handleUpdate(textUpdate("MAX"));
  assert.ok(texts(calls).at(-1).includes("1.99 SOL"));
  await bot.handleUpdate(cbUpdate(`ok:${tokenOf(calls, "✅ Confirm")}`));
  assert.equal(sentWithdraws[0].amountSol, 1.99);
});

test("withdraw rejects a bad address, junk amounts and amounts above the max", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate("not an address"));
  assert.equal(session.get("prompt").kind, "wallet-withdraw-address");
  assert.ok(texts(calls).at(-1).includes("valid Solana address"));
  await bot.handleUpdate(textUpdate(DEST));
  for (const bad of ["abc", "0", "-1", "1e3"]) {
    await bot.handleUpdate(textUpdate(bad));
    assert.equal(session.get("prompt").kind, "wallet-withdraw-amount", bad);
    assert.ok(texts(calls).at(-1).startsWith("Invalid amount"), bad);
  }
  await bot.handleUpdate(textUpdate("1.995"));
  assert.ok(texts(calls).at(-1).startsWith("Too much"));
  assert.equal(session.get("prompt").kind, "wallet-withdraw-amount");
  assert.equal(sentWithdraws.length, 0);
});

test("withdraw with a balance below the reserve ends the prompt", async () => {
  balanceSol = 0.005;
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate(DEST));
  await bot.handleUpdate(textUpdate("max"));
  assert.ok(texts(calls).at(-1).startsWith("Not enough SOL"));
  assert.equal(session.get("prompt"), null);
});

test("withdraw confirm in DRY_RUN says nothing is sent", async () => {
  deps.isDryRun = () => true;
  deps.withdrawSol = async () => ({ success: true, dryRun: true });
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate(DEST));
  await bot.handleUpdate(textUpdate("0.5"));
  assert.ok(texts(calls).at(-1).includes("DRY RUN"));
  await bot.handleUpdate(cbUpdate(`ok:${tokenOf(calls, "✅ Confirm")}`));
  assert.ok(texts(calls).at(-1).includes("nothing was sent"));
});

test("withdraw failure is reported", async () => {
  deps.withdrawSol = async () => ({ success: false, error: "RPC down" });
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate(DEST));
  await bot.handleUpdate(textUpdate("0.5"));
  await bot.handleUpdate(cbUpdate(`ok:${tokenOf(calls, "✅ Confirm")}`));
  assert.ok(texts(calls).at(-1).includes("Withdraw failed: RPC down"));
});

// ---- Fix round 1 ----

const { registerAddressRoute } = await import("../src/tg/bot.js");
const { addEntryInProgressPool, removeEntryInProgressPool } = await import("../src/entry/runtime.js");
const { PublicKey, SystemProgram } = await import("@solana/web3.js");

test("withdraw amount is whole lamports and the confirm shows the exact value that is sent", async () => {
  balanceSol = 1.23456789;
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate(DEST));
  await bot.handleUpdate(textUpdate("max"));
  assert.ok(texts(calls).at(-1).includes("Amount: 1.22456789 SOL"));
  await bot.handleUpdate(cbUpdate(`ok:${tokenOf(calls, "✅ Confirm")}`));
  assert.equal(sentWithdraws[0].amountSol, 1.22456789);
  assert.ok(texts(calls).at(-1).includes("Sent 1.22456789 SOL"));
});

test("a typed amount with more than 9 decimals is floored to a lamport", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate(DEST));
  await bot.handleUpdate(textUpdate("0.1234567899"));
  assert.ok(texts(calls).at(-1).includes("Amount: 0.123456789 SOL"));
  await bot.handleUpdate(cbUpdate(`ok:${tokenOf(calls, "✅ Confirm")}`));
  assert.equal(sentWithdraws[0].amountSol, 0.123456789);
});

test("an amount below one lamport is rejected as invalid", async () => {
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate(DEST));
  await bot.handleUpdate(textUpdate("0.0000000001"));
  assert.ok(texts(calls).at(-1).startsWith("Invalid amount"));
  assert.equal(session.get("prompt").kind, "wallet-withdraw-amount");
});

test("a mixed paste with a pubkey and the secret is deleted first and never reaches the open route", async () => {
  const routed = [];
  registerAddressRoute(async (ctx, address) => void routed.push(address));
  try {
    const fresh = Keypair.generate();
    const secret = bs58.encode(fresh.secretKey);
    const { bot, calls } = build();
    await bot.handleUpdate(cbUpdate("wal:imp"));
    calls.length = 0;
    await bot.handleUpdate(textUpdate(`pubkey: ${fresh.publicKey.toBase58()} secret: ${secret}`));
    assert.equal(calls[0].method, "deleteMessage");
    assert.deepEqual(routed, []);
    assert.ok(texts(calls).at(-1).includes("Invalid key"));
    assert.equal(walletLib.getWallet().publicKey.toBase58(), CURRENT.publicKey.toBase58());
    // seed 32 byte base58 (43-44 karakter) juga lewat prompt ini
    await bot.handleUpdate(textUpdate(bs58.encode(fresh.secretKey.slice(0, 32))));
    assert.deepEqual(routed, []);
    assert.equal(calls.filter((c) => c.method === "deleteMessage").length, 2);
  } finally {
    registerAddressRoute(async () => {});
  }
});

test("a key pasted outside the import prompt is deleted, never routed, never logged", async () => {
  const routed = [];
  registerAddressRoute(async (ctx, address) => void routed.push(address));
  try {
    const fresh = Keypair.generate();
    const secret = bs58.encode(fresh.secretKey);
    for (const text of [secret, JSON.stringify(Array.from(fresh.secretKey)), `key = ${secret}`]) {
      const { bot, calls } = build();
      await bot.handleUpdate(textUpdate(text));
      assert.equal(calls[0].method, "deleteMessage");
      const reply = texts(calls).at(-1);
      assert.ok(reply.includes("That looked like a private key — I deleted it."));
      assert.ok(reply.includes("/wallet → Import"));
      assert.ok(!reply.includes(secret));
    }
    assert.deepEqual(routed, []);
    assert.ok(!logLines.some((l) => l.includes(secret)));
    assert.equal(walletLib.getWallet().publicKey.toBase58(), CURRENT.publicKey.toBase58());
  } finally {
    registerAddressRoute(async () => {});
  }
});

test("a key pasted outside the import prompt reports a failed delete", async () => {
  failDelete = true;
  const { bot, calls } = build();
  await bot.handleUpdate(textUpdate(bs58.encode(Keypair.generate().secretKey)));
  assert.ok(texts(calls).at(-1).includes("Couldn't delete your message — delete it manually now."));
});

test("a key pasted into the withdraw address prompt is deleted and cancels the prompt", async () => {
  const secret = bs58.encode(CURRENT.secretKey);
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  calls.length = 0;
  await bot.handleUpdate(textUpdate(secret));
  assert.equal(calls[0].method, "deleteMessage");
  assert.ok(texts(calls).at(-1).includes("That looked like a private key"));
  assert.ok(!texts(calls).some((x) => x.includes(secret)));
  assert.equal(session.get("prompt"), null);
});

test("import is refused while an open is in progress, at start and after the paste", async () => {
  const { bot, calls } = build();
  addEntryInProgressPool("PoolBusy");
  try {
    await bot.handleUpdate(cbUpdate("wal:imp"));
    assert.equal(session.get("prompt"), null);
    assert.ok(texts(calls).at(-1).includes("An open is in progress"));
  } finally {
    removeEntryInProgressPool("PoolBusy");
  }
  await bot.handleUpdate(cbUpdate("wal:imp"));
  assert.equal(session.get("prompt").kind, "wallet-import");
  addEntryInProgressPool("PoolBusy");
  try {
    await bot.handleUpdate(textUpdate(bs58.encode(Keypair.generate().secretKey)));
    assert.ok(texts(calls).at(-1).includes("An open is in progress"));
    assert.equal(walletLib.getWallet().publicKey.toBase58(), CURRENT.publicKey.toBase58());
  } finally {
    removeEntryInProgressPool("PoolBusy");
  }
});

test("withdraw confirm warns about off-curve destinations only", async () => {
  const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], SystemProgram.programId)[0].toBase58();
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate(pda));
  await bot.handleUpdate(textUpdate("0.5"));
  assert.ok(texts(calls).at(-1).includes("⚠️ This address is not a normal wallet (off-curve)"));
  assert.ok(texts(calls).at(-1).includes(pda));
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate(DEST));
  await bot.handleUpdate(textUpdate("0.5"));
  assert.ok(!texts(calls).at(-1).includes("off-curve"));
});

test("the exported key message tells the user to delete it if it is still there", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const secret = bs58.encode(CURRENT.secretKey);
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:exp"));
  await bot.handleUpdate(cbUpdate(`ok:${tokenOf(calls, "I understand")}`));
  const keyMsg = calls.find((c) => c.method === "sendMessage" && c.payload.text.includes(secret));
  assert.ok(keyMsg.payload.text.includes("If this message is still here after a minute, delete it yourself."));
});

test("export never leaks the key to the console, even when sending it fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const secret = bs58.encode(CURRENT.secretKey);
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:exp"));
  const token = tokenOf(calls, "I understand");
  // Pesan kunci gagal terkirim; error API membawa payload (berisi kunci) seperti grammY.
  bot.api.config.use((prev, method, payload) => {
    if (method === "sendMessage" && payload.text.includes(secret)) {
      const err = new Error(`Call to 'sendMessage' failed! payload=${JSON.stringify(payload)}`);
      err.payload = payload;
      throw err;
    }
    return prev(method, payload);
  });
  await bot.handleUpdate(cbUpdate(`ok:${token}`));
  assert.ok(texts(calls).some((x) => x.includes("Couldn't send the key message")));
  assert.ok(!logLines.some((l) => l.includes(secret)));
  assert.ok(!texts(calls).some((x) => x.includes("Couldn't send the key message") && x.includes(secret)));
});

test("export never leaks the key to the console on success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const secret = bs58.encode(CURRENT.secretKey);
  const { bot, calls } = build();
  await bot.handleUpdate(cbUpdate("wal:exp"));
  await bot.handleUpdate(cbUpdate(`ok:${tokenOf(calls, "I understand")}`));
  t.mock.timers.tick(60000);
  await new Promise((r) => setImmediate(r));
  assert.ok(!logLines.some((l) => l.includes(secret)));
});

test("withdraw is refused while an open is in progress, at start and at confirm", async () => {
  const { bot, calls } = build();
  addEntryInProgressPool("PoolBusy");
  try {
    await bot.handleUpdate(cbUpdate("wal:wd"));
    assert.equal(session.get("prompt"), null);
    assert.ok(texts(calls).at(-1).includes("An open is in progress"));
  } finally {
    removeEntryInProgressPool("PoolBusy");
  }
  await bot.handleUpdate(cbUpdate("wal:wd"));
  await bot.handleUpdate(textUpdate(DEST));
  await bot.handleUpdate(textUpdate("0.1"));
  const token = tokenOf(calls, "✅ Confirm");
  addEntryInProgressPool("PoolBusy");
  try {
    await bot.handleUpdate(cbUpdate(`ok:${token}`));
    assert.equal(sentWithdraws.length, 0);
    assert.ok(texts(calls).at(-1).includes("An open is in progress"));
  } finally {
    removeEntryInProgressPool("PoolBusy");
  }
});
