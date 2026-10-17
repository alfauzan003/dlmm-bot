import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import
// agar test tidak menyentuh state.json / decision-log.json produksi.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tg-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { buildCloseMessage, buildStatusMessage, exitLabel } = await import("../src/notify/telegram.js");
const { trackPosition, updatePnlPeaks } = await import("../src/state/positions.js");

const POOL = "PoolFries111111111111111111111111111111111";
const POS = "PosFries1111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

// --- Closed ---

test("close: template trailing TP lengkap", () => {
  const msg = buildCloseMessage(
    "familiars-SOL",
    "trailing_tp: peak 11.40% -> 9.42%",
    9.42,
    { success: true },
    -3.5,
    11.4
  );
  assert.equal(
    msg,
    [
      "🔒 Closed familiars-SOL",
      "",
      "Trigger Exit    : Trailing TP",
      "Peak            : +11.40%",
      "Drawdown        : -3.50%",
      "",
      "Realized PnL    : +9.42%",
    ].join("\n")
  );
});

test("close: OOR kanan menampilkan Peak dan PnL di bawah", () => {
  const msg = buildCloseMessage("Agency-SOL", "oor_kanan", 0.01, { success: true }, -0.0042, 5.67);
  assert.equal(
    msg,
    [
      "🔒 Closed Agency-SOL",
      "",
      "Trigger Exit    : OOR Kanan",
      "Peak            : +5.67%",
      "Drawdown        : -0.00%",
      "",
      "Realized PnL    : +0.01%",
    ].join("\n")
  );
});

test("close: swap sukses tidak menampilkan baris swap", () => {
  const msg = buildCloseMessage("X-SOL", "stop_loss", -12.3, { success: true }, -15.1, 2);
  assert.doesNotMatch(msg, /Swap/);
});

test("close: swap gagal menampilkan alasan", () => {
  const msg = buildCloseMessage("X-SOL", "stop_loss", -12.3, { success: false, error: "slippage too high" }, -15.1, 2);
  assert.match(msg, /⚠️ Swap GAGAL: slippage too high/);
});

test("close: drawdown null tidak menampilkan baris Drawdown", () => {
  const msg = buildCloseMessage("X-SOL", "oor_kanan", 4, null, null);
  assert.doesNotMatch(msg, /Drawdown/);
});

test("exitLabel menerjemahkan alasan exit ke label pendek", () => {
  assert.equal(exitLabel("trailing_tp: peak 1 -> 2"), "Trailing TP");
  assert.equal(exitLabel("indicator_trailing(rsi_bb): peak 1 -> 2"), "Trailing Indikator");
  assert.equal(exitLabel("stop_loss"), "Stop Loss");
  assert.equal(exitLabel("oor_kanan"), "OOR Kanan");
  assert.equal(exitLabel("oor_kiri"), "OOR Kiri");
  assert.equal(exitLabel("bounce_recovery: peak -8 -> -10"), "Bounce Recovery");
  assert.equal(exitLabel("not_detected"), "Tidak Terdeteksi");
});

// --- Status ---

test("status in-range: yield tampil tanpa label In Range / OOR / MC / Vol", () => {
  resetState();
  const msg = buildStatusMessage([
    {
      pair: "familiars-SOL",
      position: "PosNoState",
      ageMinutes: 56,
      pnlPct: 10.36,
      feePct24h: 22.37,
      activeBin: 100,
      lowerBin: 90,
      upperBin: 110,
      mode: "bidask:double",
    },
  ]);
  assert.match(msg, /Yield: 22\.37%/);
  assert.doesNotMatch(msg, /In Range/);
  assert.doesNotMatch(msg, /OOR/);
  assert.doesNotMatch(msg, /MC:/);
  assert.doesNotMatch(msg, /Vol /);
});

test("status out-of-range: menampilkan tanda OOR", () => {
  resetState();
  const msg = buildStatusMessage([
    {
      pair: "familie-SOL",
      position: "PosNoState",
      ageMinutes: 10,
      pnlPct: 2,
      feePct24h: 5,
      activeBin: 100,
      lowerBin: 80,
      upperBin: 90,
      mode: "bidask:double",
    },
  ]);
  assert.match(msg, /OOR 🟢/);
});

test("status tidak lagi menampilkan Trailing / Peak / Exit at (exit per trade)", () => {
  resetState();
  trackPosition(POS, POOL, "familiars-SOL", "mint", 1, "bidask:double");
  updatePnlPeaks(POS, 11.4);

  const msg = buildStatusMessage([
    {
      pair: "familiars-SOL",
      position: POS,
      ageMinutes: 56,
      pnlPct: 9,
      feePct24h: 22.37,
      activeBin: 100,
      lowerBin: 90,
      upperBin: 110,
      mode: "bidask:double",
    },
  ]);
  assert.match(msg, /PnL: \+9\.00%/);
  assert.doesNotMatch(msg, /Trailing/);
  assert.doesNotMatch(msg, /Peak:/);
  assert.doesNotMatch(msg, /Exit at/);
});

// --- Close alert: tx + Metlex hand-off ---

const { notifyTradeClosed, notifyClose, __setSender } = await import("../src/notify/telegram.js");
const METLEX_URL = "https://www.metlex.io/pnl-cards";

function captureSender() {
  const sent = [];
  __setSender((text, extra = {}) => sent.push({ text, extra }));
  return sent;
}

test("close: closeTx tampil sebagai <code> dan teks dinamis di-escape", () => {
  const msg = buildCloseMessage("A<B>-SOL", "tp", 4, { success: false, error: "x<y" }, null, null, {
    closeTx: "sig123",
  });
  assert.match(msg, /<code>sig123<\/code>/);
  assert.match(msg, /A&lt;B&gt;-SOL/);
  assert.match(msg, /x&lt;y/);
  assert.match(msg, /Take Profit/);
});

test("close: tanpa closeTx pesan tetap teks biasa", () => {
  const msg = buildCloseMessage("A<B>-SOL", "stop_loss", -2, null);
  assert.ok(!msg.includes("<code>"));
  assert.ok(msg.includes("A<B>-SOL"));
});

test("exitLabel: label alasan trade", () => {
  assert.equal(exitLabel("tp"), "Take Profit");
  assert.equal(exitLabel("sl"), "Stop Loss");
  assert.equal(exitLabel("trail"), "Trailing");
  assert.equal(exitLabel("manual"), "Manual close");
  assert.equal(exitLabel("closed_outside"), "Closed outside bot");
});

test("notifyClose: closeTx -> HTML + tombol Metlex; tanpa closeTx -> teks biasa", () => {
  const sent = captureSender();
  notifyClose("AAA-SOL", "tp", 4, null, null, null, { closeTx: "sigX" });
  notifyClose("AAA-SOL", "tp", 4, null);
  __setSender(null);
  assert.equal(sent[0].extra.parse_mode, "HTML");
  assert.equal(sent[0].extra.reply_markup.inline_keyboard[0][0].url, METLEX_URL);
  assert.match(sent[0].text, /<code>sigX<\/code>/);
  assert.equal(sent[1].extra.parse_mode, undefined);
  assert.equal(sent[1].extra.reply_markup, undefined);
});

test("notifyTradeClosed: HTML, PnL USD dan %, durasi, tx, tombol Metlex", () => {
  const sent = captureSender();
  notifyTradeClosed(
    {
      id: 7,
      pair: "A&B-SOL",
      closeReason: "tp",
      closePnlUsd: 12.5,
      closePnlPct: 12.5,
      openedAt: Date.UTC(2026, 9, 11, 0, 0, 0),
      closedAt: Date.UTC(2026, 9, 11, 1, 5, 0),
      closeTx: "sigT",
    },
    { swapInfo: { success: false, error: "no <route>" } }
  );
  __setSender(null);
  assert.equal(sent.length, 1);
  const { text, extra } = sent[0];
  assert.equal(extra.parse_mode, "HTML");
  assert.equal(extra.reply_markup.inline_keyboard[0][0].url, METLEX_URL);
  assert.match(text, /A&amp;B-SOL/);
  assert.match(text, /Take Profit/);
  assert.match(text, /\+\$12\.50/);
  assert.match(text, /\+12\.50%/);
  assert.match(text, /1h 5m/);
  assert.match(text, /<code>sigT<\/code>/);
  assert.match(text, /no &lt;route&gt;/);
});

test("notifyTradeClosed: PnL tidak diketahui dan tanpa tx", () => {
  const sent = captureSender();
  notifyTradeClosed({
    id: 1,
    pair: "X-SOL",
    closeReason: "closed_outside",
    closePnlUsd: null,
    closePnlPct: null,
    openedAt: 0,
    closedAt: 30000,
    closeTx: null,
  });
  __setSender(null);
  assert.ok(!sent[0].text.includes("<code>"));
  assert.match(sent[0].text, /Closed outside bot/);
  assert.match(sent[0].text, /PnL.*\?/);
  assert.equal(sent[0].extra.reply_markup.inline_keyboard[0][0].url, METLEX_URL);
});
