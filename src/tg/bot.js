// Inti bot Telegram (grammY): guard satu pengguna, registrasi modul, router teks, startBot.
import { Bot, InlineKeyboard } from "grammy";
import config from "../config/index.js";
import log from "../core/logger.js";
import * as session from "./session.js";
import { extractAddress } from "./parse.js";
import { parseSecretKey } from "../solana/wallet.js";

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

// Tombol menu utama (dipakai kartu home dan petunjuk router teks).
export function homeKeyboard() {
  return new InlineKeyboard()
    .text("➕ Open", "home:open")
    .text("📂 Positions", "home:positions")
    .row()
    .text("📊 PnL", "home:pnl")
    .text("👛 Wallet", "home:wallet")
    .row()
    .text("⚙️ Settings", "home:settings")
    .text("❓ Help", "home:help");
}

const EXPIRED = "This button expired — start again";
const HINT = "Paste a token or pool address to open a position, or pick from the menu.";

// Registri router: prompt (menunggu teks) dan konfirmasi (token ok:<token>), diisi modul.
const prompts = new Map(); // kind -> { handler, acceptsAddress }
const confirms = new Map(); // action -> handler

// handler(ctx, prompt). Prompt yang tidak menerima alamat dibatalkan bila pengguna menempelkan alamat.
// handlesSecrets: prompt menangani private key sendiri (hapus pesan dulu); selain itu router menghapusnya.
export function registerPrompt(kind, handler, { acceptsAddress = false, handlesSecrets = false } = {}) {
  prompts.set(kind, { handler, acceptsAddress, handlesSecrets });
}

// handler(ctx, payload) dipanggil sekali per token sesuai payload.action.
export function registerConfirm(action, handler) {
  confirms.set(action, handler);
}

// Alamat ditempel di luar prompt: wizard /open mendaftarkan rutenya lewat registerAddressRoute
// (hindari import wizard ke sini). Sebelum terdaftar, dibalas sementara.
let addressRoute = async (ctx) => {
  await ctx.reply("Open wizard coming soon");
};

// fn(ctx, address) dipanggil saat alamat ditempel tanpa prompt yang menerimanya.
export function registerAddressRoute(fn) {
  addressRoute = fn;
}

const routeAddress = (ctx, address) => addressRoute(ctx, address);

// Teks berisi private key (utuh, atau salah satu token) — jangan sampai tertinggal di chat.
function containsSecretKey(text) {
  return parseSecretKey(text) !== null || text.split(/\s+/).some((part) => parseSecretKey(part) !== null);
}

// Hapus pesan berisi kunci yang ditempel di luar prompt import. Teksnya tidak pernah dilog.
async function dropPastedKey(ctx) {
  let deleted = true;
  try {
    await ctx.deleteMessage();
  } catch {
    deleted = false;
  }
  await ctx.reply(
    "That looked like a private key — I deleted it. Use /wallet → Import if you meant to import." +
      (deleted ? "" : "\nCouldn't delete your message — delete it manually now.")
  );
}

async function routeText(ctx) {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  const prompt = session.get("prompt");
  if (!(prompt && prompts.get(prompt.kind)?.handlesSecrets) && containsSecretKey(text)) {
    session.del("prompt");
    await dropPastedKey(ctx);
    return;
  }
  const address = extractAddress(text);
  if (prompt) {
    const entry = prompts.get(prompt.kind);
    if (entry && (entry.acceptsAddress || !address)) {
      await entry.handler(ctx, prompt);
      return;
    }
    session.del("prompt");
  }
  if (address) {
    await routeAddress(ctx, address);
    return;
  }
  await ctx.reply(HINT, { reply_markup: homeKeyboard() });
}

async function routeConfirm(ctx) {
  const payload = session.redeemToken(ctx.match[1]);
  const handler = payload ? confirms.get(payload.action) : null;
  if (!handler) {
    await ctx.answerCallbackQuery({ text: EXPIRED, show_alert: true });
    return;
  }
  await handler(ctx, payload);
}

export function createBot({ token, chatId, modules = [] }) {
  const bot = new Bot(token);
  const owner = String(chatId);
  if (Number(owner) < 0) {
    log.warn(
      "Telegram: TELEGRAM_CHAT_ID adalah grup/channel — alert tetap dikirim ke sana, tapi perintah hanya " +
        "dilayani di private chat dengan bot (chat id pribadi Anda)"
    );
  }

  // Guard pertama: hanya private chat pemilik yang dilayani (grup dengan id sama diabaikan).
  bot.use(async (ctx, next) => {
    const id = ctx.chat?.id;
    if (id == null || String(id) !== owner || ctx.chat?.type !== "private") {
      log.warn(
        `Telegram: update dari chat asing diabaikan (chat id ${id ?? "tidak ada"}, tipe ${ctx.chat?.type ?? "-"})`
      );
      return;
    }
    await next();
  });

  // Pesan "/..." membatalkan prompt yang menunggu; perintahnya ditangani handler command.
  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) session.del("prompt");
    await next();
  });

  for (const m of modules) m.register(bot);

  bot.callbackQuery(/^ok:(\w+)$/, withGuard("Confirm", routeConfirm));
  bot.on("message:text", withGuard("Message", routeText));

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
  try {
    await bot.api.setMyCommands(COMMANDS);
  } catch (err) {
    // Gagal sementara (jaringan/Telegram) tidak boleh menggagalkan boot bot yang juga mengelola posisi.
    log.warn(`Telegram setMyCommands gagal: ${err?.message ?? err}`);
  }
  bot
    .start({ drop_pending_updates: true })
    .catch((err) => log.error(`Telegram polling berhenti: ${err?.message ?? err}`));
  return bot;
}
