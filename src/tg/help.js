// /help: cara pakai per alur + daftar perintah.
import { withGuard } from "./bot.js";

export const HELP_TEXT = [
  "❓ Help",
  "",
  "➕ Open (/open): send a token mint or pool address, pick deposit, range and shape, then confirm.",
  "📂 Positions (/positions): open a position to claim fees, set TP / SL / Trail, or close it.",
  "📊 PnL (/pnl): profit today / this week / this month, with a PnL card hand-off.",
  "👛 Wallet (/wallet): deposit address, withdraw, export or import the key.",
  "⚙️ Settings (/settings): toggles (Auto Exit, Auto Entry), Auto Exit defaults and strategy settings.",
  "",
  "Tip: paste a token CA or pool address in the chat to start opening a position.",
  "",
  "Commands:",
  "/start - main menu + wallet card",
  "/open - open LP from token mint or pool address",
  "/positions - claim, set TP/SL/Trail, close",
  "/pnl - profit today / week / month",
  "/wallet - deposit, withdraw, export or import key",
  "/settings - toggles and Auto Exit defaults",
  "/help - this message",
].join("\n");

export function register(bot) {
  bot.command(
    "help",
    withGuard("/help", (ctx) => ctx.reply(HELP_TEXT))
  );
}
