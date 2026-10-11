import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// File settings diarahkan ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tg-start-"));
process.env.SETTINGS_FILE = path.join(TMP, "settings.json");

const { buildHome, gatherHomeData, sendHome, fetchSolUsd } = await import("../src/tg/start.js");
const { HELP_TEXT } = await import("../src/tg/help.js");
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

test("fetchSolUsd bypasses poll pacing and reads the SOL price", async (t) => {
  const { WSOL_MINT } = await import("../src/core/constants.js");
  const { getPrices } = await import("../src/market/jupiter-price.js");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ [WSOL_MINT]: { usdPrice: 150 } }),
  }));
  await getPrices([WSOL_MINT]); // memajukan jatah pacing
  assert.equal(await fetchSolUsd(), 150); // tetap dapat harga karena force
  assert.equal(fetchMock.mock.callCount(), 2);
});
