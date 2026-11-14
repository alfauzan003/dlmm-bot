// /swap: pilih token di wallet lalu jual seluruh saldonya ke SOL (Jupiter).
import { InlineKeyboard } from "grammy";
import config from "../config/index.js";
import log from "../core/logger.js";
import { getWalletBalances, getTokenBalance } from "../solana/balances.js";
import { swapToSol } from "../solana/swap.js";
import { getEntryInProgressPools } from "../entry/runtime.js";
import { registerConfirm, withGuard } from "./bot.js";
import { esc, fmtToken, fmtUsd, shortAddr } from "./format.js";
import * as session from "./session.js";

const HTML = { parse_mode: "HTML" };
const MAX_TOKENS = 10;
const OPEN_BUSY = "An open is in progress — try again in a minute.";

// Dependensi yang bisa diganti tes.
export const deps = {
  getBalances: getWalletBalances,
  getTokenBalance,
  swapToSol,
  isDryRun: () => config.dryRun,
  isOpenInProgress: () => getEntryInProgressPools().size > 0,
};

const finite = (n) => typeof n === "number" && Number.isFinite(n);

export function buildSwapList(tokens = []) {
  const sorted = [...tokens].filter((t) => t.balance > 0).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  if (sorted.length === 0) return { text: "🔄 Swap to SOL\n\nNo tokens in the wallet.", keyboard: null };
  const keyboard = new InlineKeyboard();
  for (const t of sorted.slice(0, MAX_TOKENS)) {
    const usd = finite(t.usd) ? ` (${fmtUsd(t.usd)})` : "";
    keyboard.text(`${t.symbol}: ${fmtToken(t.balance)}${usd}`, `swp:${t.mint}`).row();
  }
  const lines = ["🔄 Swap to SOL", "", "Pick a token — its whole balance is sold for SOL."];
  if (sorted.length > MAX_TOKENS) lines.push(`Showing top ${MAX_TOKENS} of ${sorted.length}.`);
  return { text: lines.join("\n"), keyboard };
}

async function showSwap(ctx) {
  const balances = await deps.getBalances();
  const { text, keyboard } = buildSwapList(balances?.tokens);
  await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
}

async function pickToken(ctx) {
  const mint = ctx.match[1];
  const balance = await deps.getTokenBalance(mint);
  if (!(balance > 0)) {
    await ctx.reply("That token has no balance anymore.");
    return;
  }
  const token = session.issueToken({ action: "swap", mint });
  const kb = new InlineKeyboard().text("✅ Confirm", `ok:${token}`).text("✖ Cancel", `swp:x:${token}`);
  const lines = ["🔄 Swap to SOL", "", "Token:", `<code>${esc(mint)}</code>`, `Amount: ${fmtToken(balance)} (all)`];
  if (deps.isDryRun()) lines.push("", "🧪 DRY RUN — nothing will be swapped");
  await ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
}

async function runSwap(ctx, { mint }) {
  if (deps.isOpenInProgress()) {
    await ctx.editMessageText(OPEN_BUSY).catch(() => ctx.reply(OPEN_BUSY));
    return;
  }
  // Saldo dibaca ulang saat konfirmasi: bisa berubah sejak kartu dibuat.
  const amount = await deps.getTokenBalance(mint);
  if (!(amount > 0)) {
    await ctx.editMessageText("That token has no balance anymore.").catch(() => {});
    return;
  }
  await ctx.editMessageText(`⏳ Swapping ${fmtToken(amount)} ${shortAddr(mint)} → SOL…`).catch(() => {});
  log.info(`Telegram /swap: ${amount} ${mint.slice(0, 8)} → SOL`);
  const res = await deps.swapToSol(mint, amount);
  let text;
  if (!res.success) text = `❌ Swap failed: ${esc(res.error ?? "unknown error")}`;
  else if (res.dryRun)
    text = `🧪 Dry run — nothing was swapped.\nWould sell ${fmtToken(amount)} ${esc(shortAddr(mint))}`;
  else text = `✅ Swapped ${fmtToken(amount)} ${esc(shortAddr(mint))} → SOL\nTx: <code>${esc(res.tx ?? "?")}</code>`;
  try {
    await ctx.editMessageText(text, HTML);
  } catch {
    await ctx.reply(text, HTML);
  }
}

export function register(bot) {
  bot.command("swap", withGuard("/swap", showSwap));
  bot.callbackQuery("home:swap", withGuard("Swap", showSwap));
  bot.callbackQuery(
    /^swp:x:(\w+)$/,
    withGuard("Cancel", async (ctx) => {
      session.redeemToken(ctx.match[1]);
      await ctx.editMessageText("Cancelled.").catch(() => {});
    })
  );
  bot.callbackQuery(/^swp:([1-9A-HJ-NP-Za-km-z]{32,44})$/, withGuard("Swap", pickToken));
  registerConfirm("swap", runSwap);
}
