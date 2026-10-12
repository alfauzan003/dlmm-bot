// /settings: toggle ON/OFF + default Auto Exit (TP / SL / Trail).
import { InlineKeyboard } from "grammy";
import config from "../config/index.js";
import { registerPrompt, withGuard } from "./bot.js";
import { parseAutoFlipInput, parseExitInput, parseSolAmount } from "./parse.js";
import * as session from "./session.js";
import { parseCustomRange, presetLabel } from "../lp/range.js";
import {
  getSettings,
  setToggle,
  setExitDefaults,
  TOGGLES,
  getRangePresets,
  setRangePreset,
  resetRangePresets,
  getDepositPresets,
  setDepositPresets,
  resetDepositPresets,
  setAutoFlipDefault,
} from "../state/settings.js";

const TOGGLE_LABELS = {
  autoExit: "Auto Exit",
  autoEntry: "Auto Entry",
  deterministicExit: "Deterministic Exit",
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
    if (i % 2 === 1 || i === TOGGLES.length - 1) keyboard.row();
  });
  keyboard
    .text(`🎯 TP ${d.tpPct}`, "set:edit:tp")
    .text(`🛑 SL ${d.slPct}`, "set:edit:sl")
    .text(`📈 Trail ${d.trailStartPct} / ${d.trailDistancePct}`, "set:edit:trail")
    .row()
    .text("📐 Range presets", "set:rng")
    .text(`💰 Deposits ${settings.depositPresets.join(" / ")}`, "set:dep")
    .row()
    .text(`🤖 Auto flip ${settings.autoFlipPct != null ? `${settings.autoFlipPct}%` : "off"}`, "set:autoflip");
  const text = [
    "⚙️ Settings",
    "",
    "Tap a toggle to switch it. Tap TP / SL / Trail to change the Auto Exit defaults for new trades.",
    "Range presets and Deposits set the quick-pick buttons in /open.",
    "Auto flip is the default for new bid_ask / mixed trades from /open.",
    "",
    `DRY_RUN: ${dryRun ? "on" : "off"} (.env)`,
  ].join("\n");
  return { text, keyboard };
}

// Default Auto Exit tidak punya on/off (toggle Auto Exit yang mengatur), jadi "off" tidak valid.
function parseDefaults(field, raw) {
  const parsed = parseExitInput(field, raw);
  if (!parsed?.on) return null;
  if (field === "trail") return { trailStartPct: parsed.startPct, trailDistancePct: parsed.distancePct };
  return field === "tp" ? { tpPct: parsed.pct } : { slPct: parsed.pct };
}

// Layar preset range: satu tombol per preset (label + rentang), reset, kembali.
export function buildRangePresets() {
  const keyboard = new InlineKeyboard();
  getRangePresets().forEach((p, i) => {
    keyboard.text(presetLabel(p), `set:rng:${p.key}`);
    if (i % 2 === 1) keyboard.row();
  });
  keyboard.text("↩ Reset to defaults", "set:rng:reset").text("◀ Back", "set:back");
  const text = "📐 Range presets\n\nTap a preset to change its range (% below / above the current price).";
  return { text, keyboard };
}

export function buildDepositPresets() {
  const keyboard = new InlineKeyboard()
    .text("✏️ Edit", "set:dep:edit")
    .text("↩ Reset to defaults", "set:dep:reset")
    .text("◀ Back", "set:back");
  const text = `💰 Deposit presets\n\nQuick-pick buttons in /open: ${getDepositPresets().join(" / ")} SOL`;
  return { text, keyboard };
}

// Preset 2-sisi butuh 2 angka ("20 20"); preset SOL tepat 1 angka ("20").
function parsePresetRange(key, raw) {
  const count = String(raw ?? "")
    .trim()
    .split(/\s+/).length;
  if (count !== (key.endsWith("_sol") ? 1 : 2)) return null;
  return parseCustomRange(raw);
}

function parseDeposits(raw) {
  const parts = String(raw ?? "")
    .trim()
    .split(/\s+/);
  if (parts.length !== 4) return null;
  const amounts = parts.map(parseSolAmount);
  return amounts.every((n) => n != null) ? amounts : null;
}

const editTo = (ctx, { text, keyboard }) => ctx.editMessageText(text, { ...HTML, reply_markup: keyboard });
const replyTo = (ctx, { text, keyboard }) => ctx.reply(text, { ...HTML, reply_markup: keyboard });

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

  bot.callbackQuery(
    "set:back",
    withGuard("Settings", (ctx) => editTo(ctx, buildSettings(getSettings(), config.dryRun)))
  );

  bot.callbackQuery(
    "set:rng",
    withGuard("Range presets", (ctx) => editTo(ctx, buildRangePresets()))
  );

  bot.callbackQuery(
    "set:rng:reset",
    withGuard("Range presets", (ctx) => {
      resetRangePresets();
      return editTo(ctx, buildRangePresets());
    })
  );

  bot.callbackQuery(
    /^set:rng:(\w+)$/,
    withGuard("Range presets", async (ctx) => {
      const preset = getRangePresets().find((p) => p.key === ctx.match[1]);
      if (!preset) return;
      session.put("prompt", { kind: "settings-range", key: preset.key });
      const hint = preset.key.endsWith("_sol")
        ? `Send how far below the price ${preset.label} goes, in % (e.g. ${preset.below}). It stays SOL only.`
        : `Send % below and % above the price for ${preset.label} (e.g. ${preset.below} ${preset.above}).`;
      await ctx.reply(hint);
    })
  );

  bot.callbackQuery(
    "set:dep",
    withGuard("Deposit presets", (ctx) => editTo(ctx, buildDepositPresets()))
  );

  bot.callbackQuery(
    "set:dep:edit",
    withGuard("Deposit presets", async (ctx) => {
      session.put("prompt", { kind: "settings-deposits" });
      await ctx.reply("Send 4 SOL amounts for the quick-pick buttons (e.g. 0.5 0.7 0.9 1).");
    })
  );

  bot.callbackQuery(
    "set:dep:reset",
    withGuard("Deposit presets", (ctx) => {
      resetDepositPresets();
      return editTo(ctx, buildDepositPresets());
    })
  );

  bot.callbackQuery(
    "set:autoflip",
    withGuard("Auto flip default", async (ctx) => {
      session.put("prompt", { kind: "settings-autoflip" });
      await ctx.reply("Send the default Auto flip % for new bid_ask / mixed trades (e.g. 30), or off.");
    })
  );

  registerPrompt("settings-autoflip", async (ctx) => {
    const parsed = parseAutoFlipInput(ctx.message.text);
    if (!parsed) {
      await ctx.reply("Invalid value, try again");
      return;
    }
    setAutoFlipDefault(parsed.on ? parsed.pct : null);
    session.del("prompt");
    await replySettings(ctx);
  });

  registerPrompt("settings-range", async (ctx, prompt) => {
    const parsed = parsePresetRange(prompt.key, ctx.message.text);
    if (!parsed) {
      await ctx.reply("Invalid value, try again");
      return;
    }
    setRangePreset(prompt.key, parsed);
    session.del("prompt");
    await replyTo(ctx, buildRangePresets());
  });

  registerPrompt("settings-deposits", async (ctx) => {
    const parsed = parseDeposits(ctx.message.text);
    if (!parsed) {
      await ctx.reply("Invalid value, try again");
      return;
    }
    setDepositPresets(parsed);
    session.del("prompt");
    await replyTo(ctx, buildDepositPresets());
  });

  registerPrompt("settings-exit", async (ctx, prompt) => {
    const parsed = parseDefaults(prompt.field, ctx.message.text);
    if (!parsed) {
      await ctx.reply("Invalid value, try again");
      return;
    }
    setExitDefaults(parsed);
    session.del("prompt");
    await replySettings(ctx);
  });
}
