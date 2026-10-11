// Inti bot Telegram (grammY): guard satu pengguna, registrasi modul, router teks, startBot.
import { Bot } from "grammy";
import config from "../config/index.js";
import log from "../core/logger.js";

export const COMMANDS = [
  { command: "start", description: "Main menu + wallet card" },
  { command: "open", description: "Open LP from token mint or pool address" },
  { command: "positions", description: "Claim, set TP/SL/Trail, close" },
  { command: "pnl", description: "Profit today / week / month" },
  { command: "wallet", description: "Deposit, withdraw, export or import key" },
  { command: "settings", description: "Toggles and Auto Exit defaults" },
  { command: "help", description: "How-to and command list" },
];

// Bungkus handler: error → dibalas "⚠️ <label> failed: <baris pertama>"; callback selalu di-answer.
export function withGuard(label, handler) {
  return async (ctx, next) => {
    try {
      await handler(ctx, next);
    } catch (err) {
      const first = String(err?.message ?? err).split("\n")[0];
      log.error(`Telegram ${label} failed: ${err?.stack || err}`);
      try {
        await ctx.reply(`⚠️ ${label} failed: ${first}`);
      } catch (replyErr) {
        log.error(`Telegram error reply failed: ${replyErr?.message ?? replyErr}`);
      }
    } finally {
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCallbackQuery();
        } catch {
          // silent (query sudah di-answer / kedaluwarsa)
        }
      }
    }
  };
}

export function createBot({ token, chatId, modules = [] }) {
  const bot = new Bot(token);
  const owner = String(chatId);

  // Guard pertama: hanya chat pemilik yang dilayani.
  bot.use(async (ctx, next) => {
    const id = ctx.chat?.id;
    if (id == null || String(id) !== owner) {
      log.warn(`Telegram: update dari chat asing diabaikan (chat id ${id ?? "tidak ada"})`);
      return;
    }
    await next();
  });

  for (const m of modules) m.register(bot);

  // Router teks (diisi task berikutnya).
  bot.on("message:text", async () => {});

  bot.catch((err) => {
    log.error(`Telegram bot error: ${err?.error?.stack || err?.message || err}`);
  });

  return bot;
}

export async function startBot(modules) {
  const { telegramBotToken: token, telegramChatId: chatId } = config;
  if (!token || !chatId) {
    log.warn("Telegram bot tidak dijalankan: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diisi");
    return null;
  }
  const bot = createBot({ token, chatId, modules });
  await bot.api.setMyCommands(COMMANDS);
  bot
    .start({ drop_pending_updates: true })
    .catch((err) => log.error(`Telegram polling berhenti: ${err?.message ?? err}`));
  return bot;
}
