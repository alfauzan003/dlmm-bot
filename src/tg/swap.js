// /swap: pilih token di wallet lalu jual seluruh saldonya ke SOL (Jupiter).
import { InlineKeyboard } from "grammy";
import config from "../config/index.js";
import log from "../core/logger.js";
import { getWalletBalances, getTokenBalance, getTokenNames } from "../solana/balances.js";
import { quoteToSol, swapToSol } from "../solana/swap.js";
import { getEntryInProgressPools } from "../entry/runtime.js";
import { registerConfirm, withGuard } from "./bot.js";
import { esc, fmtToken, fmtUsd, shortAddr } from "./format.js";
import * as session from "./session.js";
import { fetchSolUsd } from "./start.js";

const HTML = { parse_mode: "HTML" };
const MAX_TOKENS = 10;
const OPEN_BUSY = "An open is in progress — try again in a minute.";

// Dependensi yang bisa diganti tes.
export const deps = {
  getBalances: getWalletBalances,
  getTokenBalance,
  getTokenNames,
  quoteToSol,
  getSolUsd: fetchSolUsd,
  getSlippage: () => ({ rtse: config.swap.useRtse, bps: config.swap.slippageBps }),
  swapToSol,
  isDryRun: () => config.dryRun,
  isOpenInProgress: () => getEntryInProgressPools().size > 0,
};

const finite = (n) => typeof n === "number" && Number.isFinite(n);

// "Bonk (BONK)"; tanpa data nama → simbol/alamat pendek.
export function tokenLabel(mint, info, fallback) {
  const { name, symbol } = info ?? {};
  if (name && symbol && name !== symbol) return `${name} (${symbol})`;
  return name || symbol || fallback || shortAddr(mint);
}

// RTSE → "RTSE" (+ estimasi Jupiter bila ada); manual → "1% (100 bps)".
export function slippageLabel({ rtse, bps }, quotedBps) {
  if (rtse) return finite(quotedBps) ? `RTSE (~${quotedBps / 100}%)` : "RTSE";
  return `${bps / 100}% (${bps} bps)`;
}

async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    log.warn(`Swap: ${label} gagal: ${String(err?.message ?? err).split("\n")[0]}`);
    return null;
  }
}

export function buildSwapList(tokens = [], names = new Map()) {
  const sorted = [...tokens].filter((t) => t.balance > 0).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  if (sorted.length === 0) return { text: "🔄 Swap to SOL\n\nNo tokens in the wallet.", keyboard: null };
  const keyboard = new InlineKeyboard();
  for (const t of sorted.slice(0, MAX_TOKENS)) {
    const usd = finite(t.usd) ? ` (${fmtUsd(t.usd)})` : "";
    const label = tokenLabel(t.mint, names.get(t.mint), t.symbol);
    keyboard.text(`${label}: ${fmtToken(t.balance)}${usd}`, `swp:${t.mint}`).row();
  }
  const lines = ["🔄 Swap to SOL", "", "Pick a token — its whole balance is sold for SOL."];
  if (sorted.length > MAX_TOKENS) lines.push(`Showing top ${MAX_TOKENS} of ${sorted.length}.`);
  return { text: lines.join("\n"), keyboard };
}

async function showSwap(ctx) {
  const balances = await deps.getBalances();
  const tokens = balances?.tokens ?? [];
  const names = (await safe("nama token", () => deps.getTokenNames(tokens.map((t) => t.mint)))) ?? new Map();
  const { text, keyboard } = buildSwapList(tokens, names);
  await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
}

const NO_BALANCE = "That token has no balance anymore.";

async function pickToken(ctx) {
  const card = await buildConfirm(ctx.match[1]);
  if (!card) {
    await ctx.reply(NO_BALANCE);
    return;
  }
  await ctx.reply(card.text, { ...HTML, reply_markup: card.keyboard });
}

// Refresh: token lama ditukar token baru, saldo/quote/harga diambil ulang, kartu yang sama diedit.
async function refreshConfirm(ctx) {
  const payload = session.redeemToken(ctx.match[1]);
  if (!payload) {
    await ctx.answerCallbackQuery({ text: "This button expired — start again", show_alert: true });
    return;
  }
  const card = await buildConfirm(payload.mint);
  if (!card) {
    await ctx.editMessageText(NO_BALANCE).catch(() => {});
    return;
  }
  await ctx.editMessageText(card.text, { ...HTML, reply_markup: card.keyboard });
  await ctx.answerCallbackQuery({ text: "Refreshed" }).catch(() => {});
}

// Kartu konfirmasi (saldo, estimasi SOL/USD, slippage) + token baru; null bila saldo kosong.
async function buildConfirm(mint) {
  const balance = await deps.getTokenBalance(mint);
  if (!(balance > 0)) return null;
  const [names, quote, solUsd] = await Promise.all([
    safe("nama token", () => deps.getTokenNames([mint])),
    safe("quote", () => deps.quoteToSol(mint, balance)),
    safe("harga SOL", deps.getSolUsd),
  ]);
  const label = tokenLabel(mint, names?.get(mint));
  const outSol = quote?.outSol;
  const outUsd = finite(outSol) && finite(solUsd) ? outSol * solUsd : null;
  const token = session.issueToken({ action: "swap", mint, label });
  const keyboard = new InlineKeyboard()
    .text("✅ Confirm", `ok:${token}`)
    .text("✖ Cancel", `swp:x:${token}`)
    .row()
    .text("🔄 Refresh", `swp:r:${token}`);
  const lines = [
    "🔄 Swap to SOL",
    "",
    `Token: ${esc(label)}`,
    `<code>${esc(mint)}</code>`,
    `Amount: ${fmtToken(balance)} (all)`,
    `Est. receive: ≈ ${finite(outSol) ? `${Number(outSol.toFixed(6))} SOL` : "? SOL"} (${fmtUsd(outUsd)})`,
    `Slippage: ${slippageLabel(deps.getSlippage(), quote?.slippageBps)}`,
  ];
  if (deps.isDryRun()) lines.push("", "🧪 DRY RUN — nothing will be swapped");
  return { text: lines.join("\n"), keyboard };
}

async function runSwap(ctx, { mint, label = shortAddr(mint) }) {
  if (deps.isOpenInProgress()) {
    await ctx.editMessageText(OPEN_BUSY).catch(() => ctx.reply(OPEN_BUSY));
    return;
  }
  // Saldo dibaca ulang saat konfirmasi: bisa berubah sejak kartu dibuat.
  const amount = await deps.getTokenBalance(mint);
  if (!(amount > 0)) {
    await ctx.editMessageText(NO_BALANCE).catch(() => {});
    return;
  }
  await ctx.editMessageText(`⏳ Swapping ${fmtToken(amount)} ${label} → SOL…`).catch(() => {});
  log.info(`Telegram /swap: ${amount} ${mint.slice(0, 8)} → SOL`);
  const res = await deps.swapToSol(mint, amount);
  let text;
  if (!res.success) text = `❌ Swap failed: ${esc(res.error ?? "unknown error")}`;
  else if (res.dryRun) text = `🧪 Dry run — nothing was swapped.\nWould sell ${fmtToken(amount)} ${esc(label)}`;
  else text = `✅ Swapped ${fmtToken(amount)} ${esc(label)} → SOL\nTx: <code>${esc(res.tx ?? "?")}</code>`;
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
  bot.callbackQuery(/^swp:r:(\w+)$/, withGuard("Refresh", refreshConfirm));
  bot.callbackQuery(/^swp:([1-9A-HJ-NP-Za-km-z]{32,44})$/, withGuard("Swap", pickToken));
  registerConfirm("swap", runSwap);
}
