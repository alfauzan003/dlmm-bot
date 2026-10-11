// /positions: daftar trade terbuka, detail per trade (claim, TP/SL/Trail, close) dengan data live.
import { InlineKeyboard } from "grammy";
import log from "../core/logger.js";
import { getOpenPositions } from "../meteora/positions.js";
import { aggregateTradePnl } from "../exit/trade-exit.js";
import { claimTrade } from "../lp/claim.js";
import { closeTrade } from "../lp/close-trade.js";
import { getTrackedPosition } from "../state/positions.js";
import { getTrade, listOpenTrades, setTradeExit } from "../state/trades.js";
import { registerConfirm, registerPrompt, withGuard } from "./bot.js";
import { esc, exitSummary, fmtPct, fmtSol, fmtUsd, fmtWib, shortAddr } from "./format.js";
import { parseExitInput } from "./parse.js";
import * as session from "./session.js";

const HTML = { parse_mode: "HTML" };
// Semua layar satu trade diawali ini; tombol Back dari layar itu mengedit pesan (bukan kirim baru).
const TRADE_PREFIX = "📂 Trade #";
const BUSY = "Busy — another action is running on this trade";

// Dependensi yang bisa diganti tes.
export const deps = { getOpenPositions, claimTrade, closeTrade };

const PROMPTS = {
  tp: (id) => `Send the Take Profit % for trade #${id} (e.g. 20), or off.`,
  sl: (id) => `Send the Stop Loss % for trade #${id} (e.g. 25), or off.`,
  trail: (id) => `Send the Trailing for trade #${id} as: start distance (e.g. 5 3), or off.`,
};

const finite = (n) => typeof n === "number" && Number.isFinite(n);
// Leg yang sudah tertutup di state tidak ikut PnL/range (sama dengan loop exit).
const isLegClosed = (addr) => getTrackedPosition(addr)?.closed === true;

// Posisi live → Map by alamat; null bila gagal (UI tampil "PnL ?").
async function loadLive() {
  try {
    const list = await deps.getOpenPositions();
    return Array.isArray(list) ? new Map(list.map((p) => [p.position, p])) : null;
  } catch (err) {
    log.warn(`Positions: data live gagal: ${err?.message ?? err}`);
    return null;
  }
}

// { pnlPct, pnlUsd, inRange } untuk satu trade; field yang tidak diketahui = null.
export function liveForTrade(trade, positionsByAddr) {
  const live = { pnlPct: null, pnlUsd: null, inRange: null };
  if (!positionsByAddr) return live;
  const agg = aggregateTradePnl(trade, positionsByAddr, { isClosed: isLegClosed });
  if (agg) {
    live.pnlPct = agg.pnlPct;
    live.pnlUsd = agg.pnlUsd;
  }
  let outside = false;
  let missing = false;
  let openLegs = 0;
  for (const addr of trade.positions || []) {
    if (isLegClosed(addr)) continue;
    openLegs++;
    const p = positionsByAddr.get(addr);
    if (!p || !finite(p.activeBin) || !finite(p.lowerBin) || !finite(p.upperBin)) {
      missing = true;
      continue;
    }
    if (p.activeBin < p.lowerBin || p.activeBin > p.upperBin) outside = true;
  }
  if (outside) live.inRange = false;
  else if (!missing && openLegs > 0) live.inRange = true;
  return live;
}

function liveById(trades, positionsByAddr) {
  return new Map(trades.map((t) => [t.id, liveForTrade(t, positionsByAddr)]));
}

// "#12 BONK-SOL · spot · 0.5 SOL · +4.20% ($3.10) · in range · TP15 SL-25 T5/3"
export function tradeLine(trade, live) {
  const parts = [`#${trade.id} ${trade.pair}`, trade.shape ?? trade.origin];
  if (finite(trade.depositSol)) parts.push(fmtSol(trade.depositSol));
  parts.push(
    finite(live?.pnlPct) && finite(live?.pnlUsd) ? `${fmtPct(live.pnlPct)} (${fmtUsd(live.pnlUsd)})` : "PnL ?"
  );
  if (live?.inRange === true) parts.push("in range");
  else if (live?.inRange === false) parts.push("out of range");
  parts.push(exitSummary(trade.exit));
  return parts.join(" · ");
}

export function buildPositionsList(trades, liveByTradeId) {
  if (trades.length === 0) {
    return { text: "No open positions.", keyboard: new InlineKeyboard().text("➕ Open", "home:open") };
  }
  const keyboard = new InlineKeyboard();
  const lines = [];
  for (const t of trades) {
    const live = liveByTradeId.get(t.id);
    lines.push(esc(tradeLine(t, live)));
    const pnl = finite(live?.pnlPct) ? ` ${fmtPct(live.pnlPct)}` : "";
    keyboard.text(`#${t.id} ${t.pair}${pnl}`, `pos:open:${t.id}`).row();
  }
  keyboard.text("🔄 Refresh", "home:positions");
  return { text: [`📂 Open positions (${trades.length})`, "", ...lines].join("\n"), keyboard };
}

export function buildTradeDetail(trade, live) {
  const legs = (trade.positions || []).length;
  const text = [
    `${TRADE_PREFIX}${trade.id}`,
    "",
    esc(tradeLine(trade, live)),
    `Pool ${shortAddr(trade.pool)} · ${legs} position(s) · opened ${fmtWib(trade.openedAt)}`,
  ].join("\n");
  const id = trade.id;
  const keyboard = new InlineKeyboard()
    .text("💰 Claim", `pos:claim:${id}`)
    .text("💰 Claim+swap", `pos:claimswap:${id}`)
    .row()
    .text("🎯 TP", `pos:tp:${id}`)
    .text("🛑 SL", `pos:sl:${id}`)
    .text("📈 Trail", `pos:trail:${id}`)
    .row()
    .text("❌ Close", `pos:close:${id}`)
    .row()
    .text("🔄 Refresh", `pos:open:${id}`)
    .text("◀ Back", "home:positions");
  return { text, keyboard };
}

// Untuk kartu home dan /pnl: jumlah trade terbuka + Σ PnL USD trade yang PnL-nya diketahui
// (null = tidak ada yang diketahui; partial = ada trade terbuka yang PnL-nya tidak diketahui).
export async function summarizeOpenTrades() {
  const trades = listOpenTrades();
  if (trades.length === 0) return { count: 0, pnlUsd: 0, partial: false };
  const live = await loadLive();
  let sum = 0;
  let known = 0;
  if (live) {
    for (const t of trades) {
      const agg = aggregateTradePnl(t, live, { isClosed: isLegClosed });
      if (agg) {
        sum += agg.pnlUsd;
        known++;
      }
    }
  }
  return { count: trades.length, pnlUsd: known > 0 ? sum : null, partial: known < trades.length };
}

// "message is not modified" (mis. Refresh tanpa perubahan) bukan error.
async function editSafe(ctx, text, extra) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (/not modified/i.test(String(err?.description ?? err?.message ?? ""))) return;
    throw err;
  }
}

const show = (ctx, edit, text, keyboard) =>
  edit
    ? editSafe(ctx, text, { ...HTML, reply_markup: keyboard })
    : ctx.reply(text, { ...HTML, reply_markup: keyboard });

async function showList(ctx, edit) {
  const trades = listOpenTrades();
  const live = trades.length ? await loadLive() : null;
  const { text, keyboard } = buildPositionsList(trades, liveById(trades, live));
  await show(ctx, edit, text, keyboard);
}

function openTradeOrNull(id) {
  const trade = getTrade(id);
  return trade && trade.closed !== true ? trade : null;
}

async function notOpen(ctx, id) {
  await ctx.reply(`Trade #${id} is not open anymore.`);
}

async function showDetail(ctx, trade, edit) {
  const live = await loadLive();
  const { text, keyboard } = buildTradeDetail(trade, liveForTrade(trade, live));
  await show(ctx, edit, text, keyboard);
}

const screen = (id, line) => `${TRADE_PREFIX}${id}\n\n${line}`;

const resultKeyboard = (id) =>
  new InlineKeyboard().text("🔄 Refresh", `pos:open:${id}`).text("◀ Back", "home:positions");

// Tampilkan progres, jalankan aksi, lalu ganti pesan dengan hasilnya.
async function runAction(ctx, id, { progress, label, work, describe }) {
  await editSafe(ctx, screen(id, progress), HTML);
  let line;
  try {
    line = describe(await work());
  } catch (err) {
    log.error(`Positions: ${label} trade #${id} gagal: ${err?.stack || err}`);
    line = `⚠️ ${label} failed: ${esc(String(err?.message ?? err).split("\n")[0])}`;
  }
  await editSafe(ctx, screen(id, line), { ...HTML, reply_markup: resultKeyboard(id) });
}

function swapLine(swapInfo, requested) {
  if (!requested) return null;
  if (!swapInfo) return "Nothing to swap.";
  return swapInfo.success ? "Swapped to SOL." : `Swap failed: ${esc(swapInfo.error)} — the token stays in your wallet.`;
}

function describeClaim(res, swap) {
  if (res.busy) return BUSY;
  if (res.error) return `⚠️ Could not claim: ${esc(res.error)}`;
  const lines = [];
  if (res.failed.length === 0) lines.push(`✅ Claimed fees from ${res.claimed} position(s).`);
  else {
    lines.push(
      `⚠️ Claimed ${res.claimed} position(s). ${res.failed.length} position(s) could not be claimed ` +
        "(they may have no fees yet — see logs)."
    );
  }
  lines.push(swapLine(res.swapInfo, swap && res.claimed > 0));
  return lines.filter(Boolean).join("\n");
}

function describeClose(res, id, swap) {
  if (res.busy) return BUSY;
  if (!res.success) {
    const n = res.failed?.length ?? 0;
    return [
      `⚠️ ${n} position(s) could not be closed — the trade stays open, try again.`,
      swapLine(res.swapInfo, res.swapInfo != null),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [`✅ Trade #${id} closed.`, swapLine(res.swapInfo, swap)].filter(Boolean).join("\n");
}

export function register(bot) {
  bot.command(
    "positions",
    withGuard("/positions", (ctx) => showList(ctx, false))
  );

  bot.callbackQuery(
    "home:positions",
    withGuard("Positions", (ctx) => showList(ctx, ctx.callbackQuery.message?.text?.startsWith(TRADE_PREFIX) === true))
  );

  bot.callbackQuery(
    /^pos:open:(\d+)$/,
    withGuard("Position", async (ctx) => {
      const id = Number(ctx.match[1]);
      const trade = openTradeOrNull(id);
      if (!trade) return notOpen(ctx, id);
      await showDetail(ctx, trade, true);
    })
  );

  bot.callbackQuery(
    /^pos:(claim|claimswap):(\d+)$/,
    withGuard("Claim", async (ctx) => {
      const swap = ctx.match[1] === "claimswap";
      const id = Number(ctx.match[2]);
      const trade = openTradeOrNull(id);
      if (!trade) return notOpen(ctx, id);
      await runAction(ctx, id, {
        progress: swap ? "⏳ Claiming and swapping…" : "⏳ Claiming…",
        label: "Claim",
        work: () => deps.claimTrade(trade, { swap }),
        describe: (res) => describeClaim(res, swap),
      });
    })
  );

  bot.callbackQuery(
    /^pos:(tp|sl|trail):(\d+)$/,
    withGuard("Exit edit", async (ctx) => {
      const field = ctx.match[1];
      const id = Number(ctx.match[2]);
      if (!openTradeOrNull(id)) return notOpen(ctx, id);
      session.put("prompt", { kind: "pos-exit", id, field });
      await ctx.reply(PROMPTS[field](id));
    })
  );

  registerPrompt("pos-exit", async (ctx, prompt) => {
    const parsed = parseExitInput(prompt.field, ctx.message.text);
    if (!parsed) {
      await ctx.reply("Invalid value, try again");
      return;
    }
    session.del("prompt");
    const trade = openTradeOrNull(prompt.id);
    if (!trade) return notOpen(ctx, prompt.id);
    setTradeExit(trade.id, { [prompt.field]: parsed });
    await showDetail(ctx, getTrade(trade.id), false);
  });

  bot.callbackQuery(
    /^pos:close:(\d+)$/,
    withGuard("Close", async (ctx) => {
      const id = Number(ctx.match[1]);
      const trade = openTradeOrNull(id);
      if (!trade) return notOpen(ctx, id);
      const keyboard = new InlineKeyboard()
        .text("Close + swap to SOL", `ok:${session.issueToken({ action: "close", id, swap: true })}`)
        .row()
        .text("Close only", `ok:${session.issueToken({ action: "close", id, swap: false })}`)
        .row()
        .text("Cancel", `pos:open:${id}`);
      const legs = trade.positions.length;
      await editSafe(ctx, screen(id, `Close ${esc(trade.pair)}? This closes ${legs} position(s).`), {
        ...HTML,
        reply_markup: keyboard,
      });
    })
  );

  registerConfirm("close", async (ctx, payload) => {
    const trade = openTradeOrNull(payload.id);
    if (!trade) return notOpen(ctx, payload.id);
    await runAction(ctx, trade.id, {
      progress: "⏳ Closing…",
      label: "Close",
      work: async () => {
        const live = await loadLive();
        return deps.closeTrade(trade, { reason: "manual", swap: payload.swap, positionsByAddr: live ?? new Map() });
      },
      describe: (res) => describeClose(res, trade.id, payload.swap),
    });
  });
}
