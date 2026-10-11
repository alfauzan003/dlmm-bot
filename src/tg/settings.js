// /settings: toggle ON/OFF + default Auto Exit (TP / SL / Trail).
import { InlineKeyboard } from "grammy";
import config from "../config/index.js";
import { withGuard } from "./bot.js";
import * as session from "./session.js";
import { getSettings, setToggle, setExitDefaults, TOGGLES } from "../state/settings.js";

const TOGGLE_LABELS = {
  autoExit: "Auto Exit",
  autoEntry: "Auto Entry",
  deterministicExit: "Deterministic Exit",
  dca: "DCA",
};

const PROMPTS = {
  tp: "Send the new default Take Profit % (e.g. 15).",
  sl: "Send the new default Stop Loss % (e.g. 25).",
  trail: "Send the new default Trailing as: start distance (e.g. 5 3).",
};

const HTML = { parse_mode: "HTML" };

export function buildSettings(settings, dryRun) {
  const d = settings.exitDefaults;
  const keyboard = new InlineKeyboard();
  TOGGLES.forEach((name, i) => {
    keyboard.text(`${settings[name] ? "✅" : "❌"} ${TOGGLE_LABELS[name]}`, `set:toggle:${name}`);
    if (i % 2 === 1) keyboard.row();
  });
  keyboard
    .text(`🎯 TP ${d.tpPct}`, "set:edit:tp")
    .text(`🛑 SL ${d.slPct}`, "set:edit:sl")
    .text(`📈 Trail ${d.trailStartPct} / ${d.trailDistancePct}`, "set:edit:trail");
  const text = [
    "⚙️ Settings",
    "",
    "Tap a toggle to switch it. Tap TP / SL / Trail to change the Auto Exit defaults for new trades.",
    "",
    `DRY_RUN: ${dryRun ? "on" : "off"} (.env)`,
  ].join("\n");
  return { text, keyboard };
}

// Parser sementara (diganti parseExitInput di Task 9): angka positif terbatas.
function parseStub(field, raw) {
  const nums = String(raw ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);
  if (!nums.every((n) => Number.isFinite(n) && n > 0)) return null;
  if (field === "trail") return nums.length === 2 ? { trailStartPct: nums[0], trailDistancePct: nums[1] } : null;
  if (nums.length !== 1) return null;
  return field === "tp" ? { tpPct: nums[0] } : { slPct: nums[0] };
}

export async function replySettings(ctx) {
  const { text, keyboard } = buildSettings(getSettings(), config.dryRun);
  await ctx.reply(text, { ...HTML, reply_markup: keyboard });
}

export function register(bot) {
  bot.command("settings", withGuard("/settings", replySettings));

  bot.callbackQuery(
    /^set:toggle:(\w+)$/,
    withGuard("Settings toggle", async (ctx) => {
      const name = ctx.match[1];
      if (!TOGGLES.includes(name)) return;
      const next = setToggle(name, !getSettings()[name]);
      const { text, keyboard } = buildSettings(next, config.dryRun);
      await ctx.editMessageText(text, { ...HTML, reply_markup: keyboard });
    })
  );

  bot.callbackQuery(
    /^set:edit:(tp|sl|trail)$/,
    withGuard("Settings edit", async (ctx) => {
      const field = ctx.match[1];
      session.put("prompt", { kind: "settings-exit", field });
      await ctx.reply(PROMPTS[field]);
    })
  );

  // Jawaban prompt; teks lain diteruskan ke handler berikutnya.
  bot.on(
    "message:text",
    withGuard("Settings input", async (ctx, next) => {
      const prompt = session.get("prompt");
      if (prompt?.kind !== "settings-exit" || ctx.message.text.startsWith("/")) return next();
      const parsed = parseStub(prompt.field, ctx.message.text);
      if (!parsed) {
        await ctx.reply("Invalid value, try again");
        return;
      }
      setExitDefaults(parsed);
      session.del("prompt");
      await replySettings(ctx);
    })
  );
}
