// /settings → 🤖 Auto Entry / 🐼 Exit strategy / 🛠 Advanced: lihat & ubah setiap key strat.conf. Perubahan disimpan sebagai override
// di settings.json (stratOverrides) dan langsung berlaku, kecuali key ⟳ (setelah restart).
import { InlineKeyboard } from "grammy";
import { loadEnv } from "../config/env.js";
import { loadStratSchema, typeOf, rangeText, RESTART_KEYS } from "../config/strat-schema.js";
import { getStratOverrides, setStratOverride, clearStratOverride, clearStratOverrides } from "../state/settings.js";
import { registerPrompt, withGuard } from "./bot.js";
import { esc } from "./format.js";
import * as session from "./session.js";

const HTML = { parse_mode: "HTML" };
const PAGE_SIZE = 8;
const RESTART_NOTE = "Saved — applies after restart.";

const effectiveValue = (schema, key) => loadEnv()[key] ?? schema.entries[key]?.default ?? "";
const shown = (v) => (v === "" ? "(empty)" : v);
const short = (v) => (v.length > 16 ? `${v.slice(0, 15)}…` : v);

function pageOf(schema, key) {
  const { section } = schema.entries[key];
  return Math.floor(schema.sections[section].keys.indexOf(key) / PAGE_SIZE);
}

const AUTO_PREFIX = "Auto Entry";
const EXIT_PREFIX = "Exit strategy";
const ICONS = { "Bidask flip": "🔁", Rabbit: "🐇", Safety: "🛡", Limits: "⛔" };
const SOON = new Set(["Rabbit"]); // strategi yang belum dibangun

const partsOf = (title) => title.split(" · ");
// auto = "Auto Entry · …", exit = "Exit strategy · …", adv = sisanya.
export function groupOf(title) {
  const head = partsOf(title)[0];
  if (head === AUTO_PREFIX) return "auto";
  if (head === EXIT_PREFIX) return "exit";
  return "adv";
}

function overrideCount(schema, overrides, indexes) {
  return indexes.reduce((n, i) => n + schema.sections[i].keys.filter((k) => k in overrides).length, 0);
}

const withCount = (label, n) => (n > 0 ? `${label} (${n} ✏️)` : label);

// Grup Auto Entry: bagian "Auto Entry · X" atau "Auto Entry · X · Y"; X dengan beberapa bagian = satu tombol sub-grup.
function autoEntries(schema) {
  const entries = [];
  schema.sections.forEach((s, i) => {
    if (groupOf(s.title) !== "auto") return;
    const name = partsOf(s.title)[1] ?? s.title;
    const hit = entries.find((e) => e.name === name);
    if (hit) hit.sections.push(i);
    else entries.push({ name, sections: [i] });
  });
  return entries;
}

const iconLabel = (name) => `${ICONS[name] ? `${ICONS[name]} ` : ""}${name}${SOON.has(name) ? " (soon)" : ""}`;

export function buildStratGroup(schema, overrides, group) {
  const keyboard = new InlineKeyboard();
  if (group === "auto") {
    for (const e of autoEntries(schema)) {
      const n = overrideCount(schema, overrides, e.sections);
      const data = e.sections.length > 1 ? `st:g:auto:${e.sections[0]}` : `st:s:${e.sections[0]}:0`;
      keyboard.text(withCount(iconLabel(e.name), n), data).row();
    }
    keyboard.text("◀ Back", "set:back");
    const text = [
      "🤖 <b>Auto Entry</b>",
      "",
      "Strategies, safety checks and limits for auto trades. Turn Auto Entry on or off in /settings.",
      "Values come from strat.conf. Changes are saved as overrides in settings.json and apply right away.",
      "✏️ = overridden · ⟳ = applies after restart",
    ].join("\n");
    return { text, keyboard };
  }
  schema.sections.forEach((s, i) => {
    if (groupOf(s.title) !== "adv") return;
    keyboard.text(withCount(s.title, overrideCount(schema, overrides, [i])), `st:s:${i}:0`).row();
  });
  if (Object.keys(overrides).length > 0) keyboard.text("↩ Reset all overrides", "st:resetall").row();
  keyboard.text("◀ Back", "set:back");
  const text = [
    "🛠 <b>Advanced</b>",
    "",
    "Transactions, swaps, monitoring, market data, logs and the paper trading simulator.",
    "Values come from strat.conf. Changes are saved as overrides in settings.json and apply right away.",
    "✏️ = overridden · ⟳ = applies after restart",
  ].join("\n");
  return { text, keyboard };
}

// Sub-grup Auto Entry (mis. Bidask flip): satu tombol per bagian "Auto Entry · X · Y".
export function buildStratSubgroup(schema, overrides, firstIndex) {
  const entry = autoEntries(schema).find((e) => e.sections[0] === firstIndex);
  if (!entry) return buildStratGroup(schema, overrides, "auto");
  const keyboard = new InlineKeyboard();
  for (const i of entry.sections) {
    const title = partsOf(schema.sections[i].title).slice(2).join(" · ") || schema.sections[i].title;
    keyboard.text(withCount(title, overrideCount(schema, overrides, [i])), `st:s:${i}:0`).row();
  }
  keyboard.text("⬅ Auto Entry", "st:g:auto");
  const description = schema.sections[entry.sections[0]].description;
  let text = `🤖 <b>${esc(iconLabel(entry.name))}</b>`;
  if (description) text += `\n\n${esc(description)}`;
  return { text, keyboard };
}

// Tombol kembali dari satu bagian ke menu asalnya.
function sectionBack(schema, sectionIndex) {
  const { title } = schema.sections[sectionIndex];
  const group = groupOf(title);
  if (group === "exit") return ["⬅ Exit strategy", "set:exit"];
  if (group === "adv") return ["⬅ Advanced", "st:g:adv"];
  const entry = autoEntries(schema).find((e) => e.sections.includes(sectionIndex));
  if (entry && entry.sections.length > 1) return [`⬅ ${entry.name}`, `st:g:auto:${entry.sections[0]}`];
  return ["⬅ Auto Entry", "st:g:auto"];
}

export function buildStratSection(schema, overrides, sectionIndex, page) {
  const section = schema.sections[sectionIndex];
  const pages = Math.max(1, Math.ceil(section.keys.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const keyboard = new InlineKeyboard();
  for (const key of section.keys.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE)) {
    let label = `${key} = ${short(shown(effectiveValue(schema, key)))}`;
    if (key in overrides) label += " ✏️";
    if (RESTART_KEYS.has(key)) label += " ⟳";
    keyboard.text(label, `st:k:${key}`).row();
  }
  if (p > 0) keyboard.text("◀ Prev", `st:s:${sectionIndex}:${p - 1}`);
  if (p < pages - 1) keyboard.text("Next ▶", `st:s:${sectionIndex}:${p + 1}`);
  keyboard.row().text(...sectionBack(schema, sectionIndex));
  let text = `🧩 <b>${esc(section.title)}</b>${pages > 1 ? ` — page ${p + 1}/${pages}` : ""}`;
  if (section.description) text += `\n\n${esc(section.description)}`;
  return { text, keyboard };
}

export function buildStratKey(schema, overrides, key) {
  const entry = schema.entries[key];
  const t = typeOf(key, entry.default);
  const value = effectiveValue(schema, key);
  const lines = [
    `🧩 <b>${esc(key)}</b>`,
    `Value: <code>${esc(shown(value))}</code>  (${key in overrides ? "✏️ override" : "default"})`,
    `Default (strat.conf): <code>${esc(shown(entry.default))}</code>`,
  ];
  if (entry.help) lines.push("", esc(entry.help));
  if (RESTART_KEYS.has(key)) lines.push("", "⟳ Applies after restart");

  const keyboard = new InlineKeyboard();
  if (t.type === "bool") {
    const next = value === "true" ? "false" : "true";
    keyboard.text(`Set ${next}`, `st:set:${key}:${next}`).row();
  } else if (t.type === "enum") {
    t.options.forEach((opt, i) => {
      keyboard.text(opt === value ? `✓ ${opt}` : opt, `st:set:${key}:${opt}`);
      if (i % 2 === 1) keyboard.row();
    });
    keyboard.row();
  } else {
    keyboard.text("✏️ Edit", `st:edit:${key}`).row();
  }
  if (key in overrides) keyboard.text("↩ Reset to default", `st:reset:${key}`).row();
  keyboard.text("◀ Back", `st:s:${entry.section}:${pageOf(schema, key)}`);
  return { text: lines.join("\n"), keyboard };
}

function promptText(key, t) {
  if (t.type === "number") return `Send a new value for ${key} (${rangeText(t)})`;
  if (t.type === "file") return `Send a file name for ${key} (in the bot folder, e.g. pool.txt)`;
  if (t.type === "list") return `Send comma-separated values for ${key}, or - for empty`;
  return `Send a new value for ${key}`;
}

const edit = (ctx, { text, keyboard }) => ctx.editMessageText(text, { ...HTML, reply_markup: keyboard });
const reply = (ctx, { text, keyboard }) => ctx.reply(text, { ...HTML, reply_markup: keyboard });
const withNote = (key, view) => (RESTART_KEYS.has(key) ? { ...view, text: `${RESTART_NOTE}\n\n${view.text}` } : view);

// Tombol basi setelah strat.conf diubah: beri tahu, buang override yang tersisa.
async function knownKey(ctx, schema, key) {
  if (schema.entries[key]) return true;
  if (key in getStratOverrides()) clearStratOverride(key);
  await ctx.reply(`${key} is no longer in strat.conf.`);
  return false;
}

export function registerStrat(bot) {
  // st:home = tombol lama (sebelum menu dipecah) -> Advanced.
  bot.callbackQuery(
    /^st:(home|g:adv)$/,
    withGuard("Advanced", (ctx) => edit(ctx, buildStratGroup(loadStratSchema(), getStratOverrides(), "adv")))
  );

  bot.callbackQuery(
    "st:g:auto",
    withGuard("Auto Entry", (ctx) => edit(ctx, buildStratGroup(loadStratSchema(), getStratOverrides(), "auto")))
  );

  bot.callbackQuery(
    /^st:g:auto:(\d+)$/,
    withGuard("Auto Entry", (ctx) =>
      edit(ctx, buildStratSubgroup(loadStratSchema(), getStratOverrides(), Number(ctx.match[1])))
    )
  );

  bot.callbackQuery(
    /^st:s:(\d+):(\d+)$/,
    withGuard("Strategy section", async (ctx) => {
      const schema = loadStratSchema();
      const i = Number(ctx.match[1]);
      if (!schema.sections[i]) return edit(ctx, buildStratGroup(schema, getStratOverrides(), "adv"));
      return edit(ctx, buildStratSection(schema, getStratOverrides(), i, Number(ctx.match[2])));
    })
  );

  bot.callbackQuery(
    /^st:k:([A-Z0-9_]+)$/,
    withGuard("Strategy key", async (ctx) => {
      const schema = loadStratSchema();
      const key = ctx.match[1];
      if (!(await knownKey(ctx, schema, key))) return;
      await edit(ctx, buildStratKey(schema, getStratOverrides(), key));
    })
  );

  bot.callbackQuery(
    /^st:set:([A-Z0-9_]+):(.+)$/,
    withGuard("Strategy set", async (ctx) => {
      const schema = loadStratSchema();
      const key = ctx.match[1];
      if (!(await knownKey(ctx, schema, key))) return;
      const res = setStratOverride(key, ctx.match[2]);
      if (!res.ok) {
        await ctx.reply(res.error);
        return;
      }
      await edit(ctx, withNote(key, buildStratKey(schema, getStratOverrides(), key)));
    })
  );

  bot.callbackQuery(
    /^st:edit:([A-Z0-9_]+)$/,
    withGuard("Strategy edit", async (ctx) => {
      const schema = loadStratSchema();
      const key = ctx.match[1];
      if (!(await knownKey(ctx, schema, key))) return;
      session.put("prompt", { kind: "strat-edit", key });
      await ctx.reply(promptText(key, typeOf(key, schema.entries[key].default)));
    })
  );

  bot.callbackQuery(
    /^st:reset:([A-Z0-9_]+)$/,
    withGuard("Strategy reset", async (ctx) => {
      const schema = loadStratSchema();
      const key = ctx.match[1];
      if (!(await knownKey(ctx, schema, key))) return;
      clearStratOverride(key);
      await edit(ctx, withNote(key, buildStratKey(schema, getStratOverrides(), key)));
    })
  );

  bot.callbackQuery(
    "st:resetall",
    withGuard("Strategy reset all", (ctx) => {
      const n = Object.keys(getStratOverrides()).length;
      const keyboard = new InlineKeyboard().text("↩ Yes, reset all", "st:resetall:yes").text("✖ Cancel", "st:g:adv");
      return ctx.editMessageText(`Reset all ${n} strategy override(s) back to strat.conf?`, {
        ...HTML,
        reply_markup: keyboard,
      });
    })
  );

  bot.callbackQuery(
    "st:resetall:yes",
    withGuard("Strategy reset all", (ctx) => {
      clearStratOverrides();
      return edit(ctx, buildStratGroup(loadStratSchema(), getStratOverrides(), "adv"));
    })
  );

  registerPrompt(
    "strat-edit",
    async (ctx, prompt) => {
      const schema = loadStratSchema();
      if (!(await knownKey(ctx, schema, prompt.key))) {
        session.del("prompt");
        return;
      }
      const res = setStratOverride(prompt.key, ctx.message.text);
      if (!res.ok) {
        await ctx.reply(res.error);
        return;
      }
      session.del("prompt");
      await reply(ctx, withNote(prompt.key, buildStratKey(schema, getStratOverrides(), prompt.key)));
    },
    { acceptsAddress: true }
  );
}
