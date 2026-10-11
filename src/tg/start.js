// /start: kartu home (wallet, saldo, trade terbuka, toggle aktif) + tombol menu.
import config from "../config/index.js";
import log from "../core/logger.js";
import { WSOL_MINT } from "../core/constants.js";
import { getWallet } from "../solana/wallet.js";
import { getConnection } from "../solana/connection.js";
import { getPrices } from "../market/jupiter-price.js";
import { getSettings } from "../state/settings.js";
import { homeKeyboard, withGuard } from "./bot.js";
import { HELP_TEXT } from "./help.js";
import { replySettings } from "./settings.js";
import { summarizeOpenTrades } from "./positions.js";
import { esc, fmtSol, fmtUsd } from "./format.js";

const HTML = { parse_mode: "HTML" };
const GATHER_TIMEOUT_MS = 8000;
const TOGGLE_LABELS = [
  ["autoExit", "Auto Exit"],
  ["autoEntry", "Auto Entry"],
  ["deterministicExit", "Deterministic Exit"],
  ["dca", "DCA"],
];

export function buildHome({ address, balanceSol, solUsd, openTrades, openPnlUsd, settings, dryRun }) {
  const usd = Number.isFinite(balanceSol) && Number.isFinite(solUsd) ? balanceSol * solUsd : null;
  const on = TOGGLE_LABELS.filter(([key]) => settings[key]).map(([, label]) => label);
  const lines = [
    "🏠 Meteora LP Assistant",
    "",
    `👛 <code>${esc(address ?? "?")}</code>`,
    `💰 ${fmtSol(balanceSol)} (${fmtUsd(usd)})`,
    `📂 Open trades: ${Number.isFinite(openTrades) ? openTrades : "?"}`,
    `📈 Open PnL: ${fmtUsd(openPnlUsd)}`,
    `⚡ On: ${on.length ? on.join(", ") : "none"}`,
  ];
  if (dryRun) lines.push("", "🧪 DRY RUN");
  return { text: lines.join("\n"), keyboard: homeKeyboard() };
}

// force: lewati pacing poll supaya kartu home tidak kosong dan tidak mengambil jatah scanner.
export async function fetchSolUsd() {
  const prices = await getPrices([WSOL_MINT], { force: true });
  return prices.get(WSOL_MINT) ?? null;
}

const DEFAULT_DEPS = {
  getAddress: async () => getWallet().publicKey.toBase58(),
  getBalance: async () => (await getConnection().getBalance(getWallet().publicKey)) / 1e9,
  getSolUsd: fetchSolUsd,
  getOpenTrades: summarizeOpenTrades,
};

// Kumpulkan data home; sumber yang gagal/lambat jadi null (ditampilkan "?"), tidak pernah melempar.
export async function gatherHomeData(deps = DEFAULT_DEPS) {
  const safe = async (label, fn) => {
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), GATHER_TIMEOUT_MS);
      });
      return await Promise.race([fn(), timeout]);
    } catch (err) {
      log.warn(`Home: ${label} gagal: ${err?.message ?? err}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const [address, balanceSol, solUsd, open] = await Promise.all([
    safe("address", deps.getAddress),
    safe("balance", deps.getBalance),
    safe("harga SOL", deps.getSolUsd),
    safe("trade terbuka", deps.getOpenTrades),
  ]);
  return {
    address,
    balanceSol,
    solUsd,
    openTrades: open?.count ?? null,
    openPnlUsd: open?.pnlUsd ?? null,
  };
}

// Kirim kartu home. ctx → balas ke chat itu; bot.api → kirim ke config.telegramChatId.
export async function sendHome(ctxOrApi, { prefix = "", deps } = {}) {
  const data = await gatherHomeData(deps);
  const { text, keyboard } = buildHome({ ...data, settings: getSettings(), dryRun: config.dryRun });
  const body = prefix ? `${prefix}\n${text}` : text;
  const extra = { ...HTML, reply_markup: keyboard };
  if (typeof ctxOrApi.reply === "function") return ctxOrApi.reply(body, extra);
  return ctxOrApi.sendMessage(config.telegramChatId, body, extra);
}

export function register(bot) {
  bot.command(
    "start",
    withGuard("/start", (ctx) => sendHome(ctx))
  );
  bot.callbackQuery("home:settings", withGuard("Settings", replySettings));
  bot.callbackQuery(
    "home:help",
    withGuard("Help", (ctx) => ctx.reply(HELP_TEXT))
  );
  // Fitur belum ada: dijawab sementara (home:open ditangani open-wizard, home:pnl oleh pnl.js).
  bot.callbackQuery(
    /^home:wallet$/,
    withGuard("Home", (ctx) => ctx.reply("Coming soon"))
  );
}
