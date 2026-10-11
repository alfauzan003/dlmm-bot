// /pnl: profit today / week / month (WIB), plus recent closes with the Metlex hand-off.
import { InlineKeyboard } from "grammy";
import { periodStart, summarize } from "../lp/pnl-stats.js";
import { listClosedTrades } from "../state/trades.js";
import { exitLabel } from "../notify/telegram.js";
import { withGuard } from "./bot.js";
import { esc, fmtPct, fmtUsd, fmtWib } from "./format.js";
import { summarizeOpenTrades } from "./positions.js";

const HTML = { parse_mode: "HTML" };
const METLEX_URL = "https://www.metlex.io/pnl-cards";
const RECENT_LIMIT = 10;
const PERIODS = [
  ["today", "Today"],
  ["week", "This week"],
  ["month", "This month"],
];

// Dependensi yang bisa diganti tes.
export const deps = { summarizeOpenTrades };

const finite = (n) => typeof n === "number" && Number.isFinite(n);
const signedUsd = (n) => (finite(n) && n > 0 ? `+${fmtUsd(n)}` : fmtUsd(n));
const tradeRef = (t) => (t ? `#${t.id} ${esc(t.pair)} ${signedUsd(t.closePnlUsd)}` : "—");

export function buildPnl(period, summary, openPnlUsd, openPartial = false) {
  const label = PERIODS.find(([key]) => key === period)?.[1] ?? period;
  const win = finite(summary.winRatePct) ? `${Math.round(summary.winRatePct)}% (wins: ${summary.wins})` : "—";
  const open = `${signedUsd(openPnlUsd)}${finite(openPnlUsd) && openPartial ? " (partial)" : ""}`;
  const text = [
    `📊 PnL · ${label}`,
    `since ${fmtWib(periodStart(period))}`,
    "",
    `Realized: ${signedUsd(summary.pnlUsd)} · ${summary.count} close(s)`,
    `Win rate: ${win}`,
    `Best: ${tradeRef(summary.best)}`,
    `Worst: ${tradeRef(summary.worst)}`,
    "",
    `Open (unrealized): ${open}`,
  ].join("\n");
  const keyboard = new InlineKeyboard();
  for (const [key, name] of PERIODS) keyboard.text(key === period ? `• ${name}` : name, `pnl:${key}`);
  keyboard.row().text("🧾 Recent closes", "pnl:recent");
  return { text, keyboard };
}

function recentLine(t) {
  const pnl =
    finite(t.closePnlPct) && finite(t.closePnlUsd) ? `${fmtPct(t.closePnlPct)} (${fmtUsd(t.closePnlUsd)})` : "PnL ?";
  const head = `#${t.id} ${esc(t.pair)} · ${pnl} · ${esc(exitLabel(t.closeReason))} · ${fmtWib(t.closedAt)}`;
  return `${head}\n${t.closeTx ? `<code>${esc(t.closeTx)}</code>` : "no tx"}`;
}

export function buildRecent(trades) {
  const keyboard = new InlineKeyboard();
  if (trades.length === 0) {
    keyboard.text("◀ Back", "pnl:today");
    return { text: "🧾 Recent closes\n\nNo closed trades yet.", keyboard };
  }
  const last = [...trades].sort((a, b) => b.closedAt - a.closedAt).slice(0, RECENT_LIMIT);
  const text = [`🧾 Recent closes (${last.length})`, "", ...last.map(recentLine).flatMap((l) => [l, ""])]
    .join("\n")
    .trimEnd();
  keyboard.url("🖼 Open Metlex", METLEX_URL).row().text("◀ Back", "pnl:today");
  return { text, keyboard };
}

async function periodScreen(period) {
  const summary = summarize(listClosedTrades({ sinceMs: periodStart(period) }));
  const open = await deps.summarizeOpenTrades();
  return buildPnl(period, summary, open?.pnlUsd ?? null, open?.partial === true);
}

// edit: ubah pesan di tempat; bila gagal (mis. pesan lama) kirim pesan baru. "not modified" bukan error.
async function show(ctx, edit, { text, keyboard }) {
  const extra = { ...HTML, reply_markup: keyboard };
  if (!edit) return ctx.reply(text, extra);
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (/not modified/i.test(String(err?.description ?? err?.message ?? ""))) return;
    await ctx.reply(text, extra);
  }
}

export function register(bot) {
  bot.command(
    "pnl",
    withGuard("/pnl", async (ctx) => show(ctx, false, await periodScreen("today")))
  );
  bot.callbackQuery(
    "home:pnl",
    withGuard("PnL", async (ctx) => show(ctx, false, await periodScreen("today")))
  );
  bot.callbackQuery(
    /^pnl:(today|week|month)$/,
    withGuard("PnL", async (ctx) => show(ctx, true, await periodScreen(ctx.match[1])))
  );
  bot.callbackQuery(
    "pnl:recent",
    withGuard("PnL", async (ctx) => show(ctx, true, buildRecent(listClosedTrades())))
  );
}
