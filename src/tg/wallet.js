// /wallet: kartu wallet, deposit, withdraw SOL, export dan import private key.
// Kunci rahasia TIDAK BOLEH masuk log, pesan error, atau cache mana pun.
import { InlineKeyboard } from "grammy";
import { PublicKey } from "@solana/web3.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { getConnection } from "../solana/connection.js";
import { getWalletBalances } from "../solana/balances.js";
import { exportSecretKey, getWallet, parseSecretKey, reloadWallet, saveWalletKey } from "../solana/wallet.js";
import { maxWithdrawSol, withdrawSol, WITHDRAW_RESERVE_SOL } from "../solana/transfer.js";
import { listOpenTrades } from "../state/trades.js";
import { registerConfirm, registerPrompt, withGuard } from "./bot.js";
import { esc, fmtSol, fmtUsd } from "./format.js";
import { parseSolAmount } from "./parse.js";
import * as session from "./session.js";
import { fetchSolUsd } from "./start.js";

const HTML = { parse_mode: "HTML" };
const EXPORT_DELETE_MS = 60000;
const TOKEN_LINES = 5;

// Dependensi yang bisa diganti tes.
export const deps = {
  getAddress: () => getWallet().publicKey.toBase58(),
  getBalances: getWalletBalances,
  getSolBalance: async () => (await getConnection().getBalance(getWallet().publicKey)) / 1e9,
  getSolUsd: fetchSolUsd,
  withdrawSol,
  isDryRun: () => config.dryRun,
};

const firstLine = (err) => String(err?.message ?? err).split("\n")[0];
const finite = (n) => typeof n === "number" && Number.isFinite(n);

function tokenLine(t) {
  const amount = Number(t.balance.toPrecision(6));
  return `• ${esc(t.symbol)}: ${amount}${finite(t.usd) ? ` (${fmtUsd(t.usd)})` : ""}`;
}

export function buildWallet({ address, sol, solUsd, tokens = [] }) {
  const usd = finite(sol) && finite(solUsd) ? sol * solUsd : null;
  const sorted = [...tokens].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const lines = ["👛 Wallet", "", `<code>${esc(address ?? "?")}</code>`, `💰 ${fmtSol(sol)} (${fmtUsd(usd)})`];
  if (sorted.length === 0) {
    lines.push("🪙 No other tokens");
  } else {
    lines.push("🪙 Tokens:", ...sorted.slice(0, TOKEN_LINES).map(tokenLine));
    if (sorted.length > TOKEN_LINES) lines.push(`+${sorted.length - TOKEN_LINES} more`);
  }
  const keyboard = new InlineKeyboard()
    .text("📥 Deposit", "wal:dep")
    .text("📤 Withdraw", "wal:wd")
    .row()
    .text("🔑 Export", "wal:exp")
    .text("📲 Import", "wal:imp");
  return { text: lines.join("\n"), keyboard };
}

async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    log.warn(`Wallet: ${label} gagal: ${firstLine(err)}`);
    return null;
  }
}

async function showWallet(ctx) {
  const [address, balances, solUsd] = await Promise.all([
    safe("address", deps.getAddress),
    safe("balances", deps.getBalances),
    safe("harga SOL", deps.getSolUsd),
  ]);
  const { text, keyboard } = buildWallet({ address, sol: balances?.sol, solUsd, tokens: balances?.tokens });
  await ctx.reply(text, { ...HTML, reply_markup: keyboard });
}

async function showDeposit(ctx) {
  const address = deps.getAddress();
  await ctx.reply(
    `📥 Deposit\n\nSend SOL on Solana to this address (tap to copy):\n<code>${esc(address)}</code>`,
    HTML
  );
}

// ---- Withdraw ----

async function startWithdraw(ctx) {
  session.put("prompt", { kind: "wallet-withdraw-address" });
  await ctx.reply("📤 Withdraw SOL\n\nSend the destination address");
}

async function onWithdrawAddress(ctx) {
  let to = null;
  try {
    to = new PublicKey(String(ctx.message.text ?? "").trim()).toBase58();
  } catch {
    to = null;
  }
  if (!to) {
    await ctx.reply("That isn't a valid Solana address. Send the destination address");
    return;
  }
  session.put("prompt", { kind: "wallet-withdraw-amount", to });
  await ctx.reply(`Send the amount in SOL, or "max" (keeps ${WITHDRAW_RESERVE_SOL} SOL for fees)`);
}

async function onWithdrawAmount(ctx, prompt) {
  const text = String(ctx.message.text ?? "").trim();
  const wantsMax = text.toLowerCase() === "max";
  const typed = wantsMax ? null : parseSolAmount(text);
  if (!wantsMax && typed == null) {
    await ctx.reply('Invalid amount, send a number or "max"');
    return;
  }
  let balance;
  try {
    balance = await deps.getSolBalance();
  } catch (err) {
    session.del("prompt");
    await ctx.reply(`Couldn't read your balance: ${firstLine(err)}`);
    return;
  }
  const max = maxWithdrawSol(balance);
  const amountSol = wantsMax ? max : typed;
  if (!(amountSol > 0)) {
    session.del("prompt");
    await ctx.reply(
      `Not enough SOL to withdraw (balance ${fmtSol(balance)}, ${WITHDRAW_RESERVE_SOL} SOL stays for fees).`
    );
    return;
  }
  if (amountSol > max + 1e-9) {
    await ctx.reply(`Too much. You can withdraw up to ${fmtSol(max)}. Send a smaller amount or "max"`);
    return;
  }
  session.del("prompt");
  const token = session.issueToken({ action: "withdraw", to: prompt.to, amountSol });
  const kb = new InlineKeyboard().text("✅ Confirm", `ok:${token}`).text("✖ Cancel", `wal:x:${token}`);
  const lines = ["📤 Withdraw", "", "To:", `<code>${esc(prompt.to)}</code>`, `Amount: ${fmtSol(amountSol)}`];
  if (deps.isDryRun()) lines.push("", "🧪 DRY RUN — nothing will be sent");
  await ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
}

async function runWithdraw(ctx, { to, amountSol }) {
  const dryRun = deps.isDryRun();
  await ctx.editMessageText(`⏳ ${dryRun ? "Simulating" : "Sending"} ${fmtSol(amountSol)}…`).catch(() => {});
  const res = await deps.withdrawSol({ to, amountSol });
  let text;
  if (!res.success) text = `❌ Withdraw failed: ${esc(res.error ?? "unknown error")}`;
  else if (res.dryRun)
    text = `🧪 Dry run — nothing was sent.\nWould send ${fmtSol(amountSol)} to\n<code>${esc(to)}</code>`;
  else text = `✅ Sent ${fmtSol(amountSol)} to\n<code>${esc(to)}</code>\nTx: <code>${esc(res.tx)}</code>`;
  try {
    await ctx.editMessageText(text, HTML);
  } catch {
    await ctx.reply(text, HTML);
  }
}

// ---- Export ----

async function startExport(ctx) {
  const token = session.issueToken({ action: "export" });
  const kb = new InlineKeyboard().text("I understand", `ok:${token}`).text("✖ Cancel", `wal:x:${token}`);
  await ctx.reply(
    "🔑 Export private key\n\n" +
      "⚠️ Your key will appear in this chat for 60 seconds, then be deleted. " +
      "Anyone who sees it can take all your funds. Make sure nobody is watching.",
    { reply_markup: kb }
  );
}

async function runExport(ctx) {
  let sent;
  try {
    sent = await ctx.reply(`🔑 Private key (tap to copy). Deleting in 60 s:\n<code>${exportSecretKey()}</code>`, HTML);
  } catch {
    // Error asli tidak diteruskan: payload-nya memuat kunci.
    throw new Error("Couldn't send the key message");
  }
  const { api } = ctx;
  const chatId = sent.chat?.id ?? ctx.chat.id;
  const messageId = sent.message_id;
  setTimeout(async () => {
    try {
      await api.deleteMessage(chatId, messageId);
    } catch {
      try {
        await api.sendMessage(chatId, "Couldn't auto-delete the key message — delete it manually.");
      } catch {
        // tidak ada lagi yang bisa dilakukan
      }
    }
  }, EXPORT_DELETE_MS);
  await ctx.editMessageText("🔑 Key sent below. It will be deleted in 60 s.").catch(() => {});
}

// ---- Import ----

const CLOSE_FIRST = "Close all trades first — the open positions belong to the current wallet.";

async function startImport(ctx) {
  if (listOpenTrades().length > 0) {
    await ctx.reply(CLOSE_FIRST);
    return;
  }
  session.put("prompt", { kind: "wallet-import" });
  await ctx.reply(
    "📲 Import wallet\n\nSend the private key (base58 or JSON array). I'll delete your message right away. " +
      "This replaces the current wallet; keep its key if it still holds funds."
  );
}

async function onImportKey(ctx) {
  // Pesan berisi kunci: hapus dulu sebelum apa pun.
  let deleted = true;
  try {
    await ctx.deleteMessage();
  } catch {
    deleted = false;
  }
  if (!deleted) await ctx.reply("Couldn't delete your message — delete it manually now.");

  const keypair = parseSecretKey(ctx.message.text);
  if (!keypair) {
    await ctx.reply("Invalid key. Send a valid private key, or /start to cancel");
    return;
  }
  session.del("prompt");
  // Trade bisa terbuka (auto-entry) sejak prompt dibuka: cek lagi.
  if (listOpenTrades().length > 0) {
    await ctx.reply(CLOSE_FIRST);
    return;
  }
  const address = keypair.publicKey.toBase58();
  const current = await safe("address", deps.getAddress);
  if (current === address) {
    await ctx.reply("That's already the active wallet");
    return;
  }
  saveWalletKey(keypair);
  reloadWallet();
  log.info(`wallet imported: ${address}`);
  await ctx.reply(`✅ Wallet imported\n<code>${esc(address)}</code>`, HTML);
}

export function register(bot) {
  bot.command("wallet", withGuard("/wallet", showWallet));
  bot.callbackQuery("home:wallet", withGuard("Wallet", showWallet));
  bot.callbackQuery("wal:dep", withGuard("Deposit", showDeposit));
  bot.callbackQuery("wal:wd", withGuard("Withdraw", startWithdraw));
  bot.callbackQuery("wal:exp", withGuard("Export", startExport));
  bot.callbackQuery("wal:imp", withGuard("Import", startImport));
  bot.callbackQuery(
    /^wal:x:(\w+)$/,
    withGuard("Cancel", async (ctx) => {
      session.redeemToken(ctx.match[1]);
      await ctx.editMessageText("Cancelled.").catch(() => {});
    })
  );

  registerPrompt("wallet-withdraw-address", onWithdrawAddress, { acceptsAddress: true });
  registerPrompt("wallet-withdraw-amount", onWithdrawAmount);
  // Kunci 64 byte (~88 karakter) tidak dianggap alamat oleh router, jadi sampai ke prompt ini.
  registerPrompt("wallet-import", onImportKey, { acceptsAddress: false });

  registerConfirm("withdraw", runWithdraw);
  registerConfirm("export", runExport);
}
