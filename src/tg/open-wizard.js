// Wizard /open: alamat → pool → deposit SOL → range → shape → konfirmasi → open on-chain.
import { InlineKeyboard } from "grammy";
import { resolveAddress, poolButtonLabel } from "../lp/pool-lookup.js";
import { RANGE_PRESETS, parseCustomRange } from "../lp/range.js";
import { SHAPES, planOpen, executeOpen } from "../lp/open-trade.js";
import { exitPresetForNewTrade } from "../state/settings.js";
import { registerAddressRoute, registerConfirm, registerPrompt, withGuard } from "./bot.js";
import { esc, exitSummary, fmtSol } from "./format.js";
import { extractAddress, parseSolAmount } from "./parse.js";
import * as session from "./session.js";

const HTML = { parse_mode: "HTML" };
const DEPOSITS = ["0.5", "0.7", "0.9", "1"];
const EXPIRED = "This wizard expired — send /open again";
const RANGE_PROMPT = "Send `45` for −45% SOL only, or `45 10` for −45% / +10%";

// Dependensi yang bisa diganti tes.
export const deps = { resolveAddress, planOpen, executeOpen, getExitPreset: exitPresetForNewTrade };

const firstLine = (err) => String(err?.message ?? err).split("\n")[0];

async function editSafe(ctx, text, extra) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (/not modified/i.test(String(err?.description ?? err?.message ?? ""))) return;
    throw err;
  }
}

// Dari tombol → edit pesan kartu; dari teks → kirim pesan baru.
const show = (ctx, text, keyboard) => {
  const extra = { ...HTML, ...(keyboard ? { reply_markup: keyboard } : {}) };
  return ctx.callbackQuery ? editSafe(ctx, text, extra) : ctx.reply(text, extra);
};

const save = (wizard) => session.put("wizard", wizard);

const fmtTvl = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

// Harga kecil (token memecah ke ~1e-8 SOL) tanpa notasi eksponen.
function fmtPrice(n) {
  if (!(n > 0)) return "?";
  const decimals = Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(n))));
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

// info = { name, priceSol?, binStep?, baseFeePct?, tvlUsd? } — hanya field yang ada yang ditampilkan.
export function buildPoolCard(info) {
  const lines = [`🏊 <b>${esc(info.name)}</b>`];
  if (Number.isFinite(info.priceSol)) lines.push(`Price: ${fmtPrice(info.priceSol)} SOL`);
  const cfg = [];
  if (Number.isFinite(info.binStep)) cfg.push(`Bin step: ${info.binStep}`);
  if (Number.isFinite(Number(info.baseFeePct)) && info.baseFeePct != null)
    cfg.push(`Base fee: ${Number(info.baseFeePct)}%`);
  if (cfg.length) lines.push(cfg.join(" · "));
  if (Number.isFinite(info.tvlUsd)) lines.push(`TVL: ${fmtTvl(info.tvlUsd)}`);
  return lines.join("\n");
}

// Ringkasan rencana untuk kartu konfirmasi (teks HTML).
export function buildConfirm(plan, exit) {
  const anyExit = exit && (exit.tp?.on || exit.sl?.on || exit.trail?.on);
  const swap = plan.solOnly || !(plan.swapSol > 0) ? "SOL only" : `Swap: ${fmtSol(plan.swapSol)} → token`;
  return [
    `📋 <b>Open ${esc(plan.pair)}</b>`,
    `Deposit: ${fmtSol(plan.depositSol)}`,
    `Range: −${plan.below}% / +${plan.above}% (${fmtPrice(plan.lowSol)} – ${fmtPrice(plan.highSol)} SOL)`,
    `${plan.binCount} bins · ${plan.positionCount} position(s) · ${plan.shape}`,
    swap,
    `Rent (refundable): ${fmtSol(plan.rentSol)}`,
    anyExit ? `Exits: ${exitSummary(exit)}` : "Auto Exit off",
  ].join("\n");
}

const cancelRow = (kb) => kb.text("✖ Cancel", "op:cancel");

function depositKeyboard() {
  const kb = new InlineKeyboard();
  for (const d of DEPOSITS) kb.text(d, `op:dep:${d}`);
  return cancelRow(kb.text("Custom", "op:dep:custom").row());
}

function rangeKeyboard() {
  const kb = new InlineKeyboard();
  RANGE_PRESETS.forEach((p, i) => {
    kb.text(p.label, `op:rng:${p.key}`);
    if (i % 3 === 2) kb.row();
  });
  return kb.text("Custom", "op:rng:custom").row().text("◀ Back", "op:back");
}

const SHAPE_LABELS = { spot: "Spot", curve: "Curve", bid_ask: "Bid-Ask", mixed: "Mixed" };

function shapeKeyboard() {
  const kb = new InlineKeyboard();
  for (const s of SHAPES) kb.text(SHAPE_LABELS[s] ?? s, `op:shp:${s}`);
  return kb.row().text("◀ Back", "op:back");
}

async function showDeposit(ctx, wizard) {
  wizard.step = "deposit";
  save(wizard);
  await show(ctx, `${buildPoolCard(wizard.pool)}\n\nHow much SOL do you want to deposit?`, depositKeyboard());
}

async function showRange(ctx, wizard) {
  wizard.step = "range";
  save(wizard);
  await show(ctx, "Choose a price range (below / above the current price):", rangeKeyboard());
}

async function showShape(ctx, wizard) {
  wizard.step = "shape";
  save(wizard);
  await show(ctx, "Choose the liquidity shape:", shapeKeyboard());
}

// Semua input diketahui → rencana. Error/throw ditampilkan sebagai teks, bukan kartu konfirmasi.
async function showPlan(ctx, wizard) {
  wizard.step = "confirm";
  wizard.plan = null;
  save(wizard);
  if (ctx.callbackQuery) await editSafe(ctx, "⏳ Planning…", HTML);
  const back = new InlineKeyboard().text("◀ Back", "op:back").text("✖ Cancel", "op:cancel");
  let plan;
  try {
    plan = await deps.planOpen({
      poolAddress: wizard.poolAddress,
      depositSol: wizard.depositSol,
      below: wizard.below,
      above: wizard.above,
      shape: wizard.shape,
    });
  } catch (err) {
    await show(ctx, `Couldn't plan this position: ${esc(firstLine(err))}`, back);
    return;
  }
  if (plan?.error) {
    await show(ctx, `❌ ${esc(plan.error)}`, back);
    return;
  }
  wizard.plan = plan;
  save(wizard);
  const token = session.issueToken({ action: "open", plan });
  const kb = new InlineKeyboard()
    .text("✅ Confirm", `ok:${token}`)
    .row()
    .text("◀ Back", "op:back")
    .text("✖ Cancel", "op:cancel");
  await show(ctx, buildConfirm(plan, deps.getExitPreset()), kb);
}

// Alamat ditempel (atau dikirim ke prompt /open): cari pool lalu mulai wizard baru.
async function startFromAddress(ctx, address) {
  session.del("prompt");
  let res;
  try {
    res = await deps.resolveAddress(address);
  } catch (err) {
    await ctx.reply(`Couldn't look up that address: ${firstLine(err)}`);
    return;
  }
  if (res.type === "invalid") {
    await ctx.reply("Not a DLMM pool or token with a SOL pool.");
    return;
  }
  if (res.type === "not_sol") {
    await ctx.reply(`Only SOL pairs are supported (${res.pair}).`);
    return;
  }
  if (res.type === "pool") {
    const wizard = { step: "deposit", poolAddress: res.pool.address, pool: { name: res.pool.name } };
    await showDeposit(ctx, wizard);
    return;
  }
  const wizard = { step: "pool", candidates: res.pools };
  save(wizard);
  const kb = new InlineKeyboard();
  res.pools.forEach((p, i) => kb.text(poolButtonLabel(p), `op:pool:${i}`).row());
  await ctx.reply(`Pick a pool for ${esc(res.pools[0].name)}:`, { ...HTML, reply_markup: cancelRow(kb) });
}

// Callback op:*: bersihkan prompt basi, wajib ada wizard aktif.
function wizardCallback(label, handler, { keepPrompt = false } = {}) {
  return withGuard(label, async (ctx) => {
    if (!keepPrompt) session.del("prompt");
    const wizard = session.get("wizard");
    if (!wizard) {
      await ctx.reply(EXPIRED);
      return;
    }
    await handler(ctx, wizard);
  });
}

async function runConfirm(ctx, payload) {
  const { plan } = payload;
  session.del("wizard");
  const exit = deps.getExitPreset();
  const edit = (text, keyboard) => editSafe(ctx, text, { ...HTML, ...(keyboard ? { reply_markup: keyboard } : {}) });
  await edit("⏳ Opening…");
  const res = await deps.executeOpen(plan, { onProgress: (text) => edit(`⏳ ${esc(text)}`) });
  if (!res.success) {
    await edit(`❌ Open failed: ${esc(res.error ?? "unknown error")}`);
    return;
  }
  if (res.dryRun) {
    await edit(`🧪 Dry run — nothing was sent.\n\n${buildConfirm(plan, exit)}`);
    return;
  }
  const warning = res.warning ? `\n⚠️ ${esc(res.warning)}` : "";
  await edit(`✅ Opened #${res.trade.id}${warning}`, new InlineKeyboard().text("Manage", `pos:open:${res.trade.id}`));
}

async function startPrompt(ctx) {
  session.del("wizard");
  session.put("prompt", { kind: "open-address" });
  await ctx.reply("Send a pool address or token mint");
}

export function register(bot) {
  registerAddressRoute(startFromAddress);

  bot.command("open", withGuard("/open", startPrompt));
  bot.callbackQuery("home:open", withGuard("Open", startPrompt));

  registerPrompt(
    "open-address",
    async (ctx) => {
      const address = extractAddress(ctx.message.text);
      if (!address) {
        await ctx.reply("That doesn't look like an address. Send a pool address or token mint");
        return;
      }
      await startFromAddress(ctx, address);
    },
    { acceptsAddress: true }
  );

  registerPrompt("open-deposit", async (ctx) => {
    const amount = parseSolAmount(ctx.message.text);
    if (amount == null) {
      await ctx.reply("Invalid amount, try again");
      return;
    }
    session.del("prompt");
    const wizard = session.get("wizard");
    if (!wizard) {
      await ctx.reply(EXPIRED);
      return;
    }
    wizard.depositSol = amount;
    await showRange(ctx, wizard);
  });

  registerPrompt("open-range", async (ctx) => {
    const range = parseCustomRange(ctx.message.text);
    if (!range) {
      await ctx.reply("Invalid range, try again");
      return;
    }
    session.del("prompt");
    const wizard = session.get("wizard");
    if (!wizard) {
      await ctx.reply(EXPIRED);
      return;
    }
    wizard.below = range.below;
    wizard.above = range.above;
    await showShape(ctx, wizard);
  });

  bot.callbackQuery(
    /^op:pool:(\d+)$/,
    wizardCallback("Pool", async (ctx, wizard) => {
      const pool = wizard.candidates?.[Number(ctx.match[1])];
      if (!pool) {
        await ctx.reply(EXPIRED);
        return;
      }
      wizard.poolAddress = pool.address;
      wizard.pool = pool;
      await showDeposit(ctx, wizard);
    })
  );

  bot.callbackQuery(
    "op:dep:custom",
    wizardCallback(
      "Deposit",
      async (ctx) => {
        session.put("prompt", { kind: "open-deposit" });
        await ctx.reply("Send the deposit in SOL (e.g. 0.3)");
      },
      { keepPrompt: true }
    )
  );

  bot.callbackQuery(
    /^op:dep:(0\.5|0\.7|0\.9|1)$/,
    wizardCallback("Deposit", async (ctx, wizard) => {
      wizard.depositSol = Number(ctx.match[1]);
      await showRange(ctx, wizard);
    })
  );

  bot.callbackQuery(
    "op:rng:custom",
    wizardCallback(
      "Range",
      async (ctx) => {
        session.put("prompt", { kind: "open-range" });
        await ctx.reply(RANGE_PROMPT, { parse_mode: "Markdown" });
      },
      { keepPrompt: true }
    )
  );

  bot.callbackQuery(
    /^op:rng:(\w+)$/,
    wizardCallback("Range", async (ctx, wizard) => {
      const preset = RANGE_PRESETS.find((p) => p.key === ctx.match[1]);
      if (!preset) return;
      wizard.below = preset.below;
      wizard.above = preset.above;
      await showShape(ctx, wizard);
    })
  );

  bot.callbackQuery(
    /^op:shp:(\w+)$/,
    wizardCallback("Shape", async (ctx, wizard) => {
      if (!SHAPES.includes(ctx.match[1])) return;
      wizard.shape = ctx.match[1];
      await showPlan(ctx, wizard);
    })
  );

  bot.callbackQuery(
    "op:back",
    wizardCallback("Back", async (ctx, wizard) => {
      if (wizard.step === "confirm") await showShape(ctx, wizard);
      else if (wizard.step === "shape") await showRange(ctx, wizard);
      else if (wizard.step === "range") await showDeposit(ctx, wizard);
    })
  );

  bot.callbackQuery(
    "op:cancel",
    withGuard("Cancel", async (ctx) => {
      session.del("wizard");
      session.del("prompt");
      await editSafe(ctx, "Cancelled.");
    })
  );

  registerConfirm("open", runConfirm);
}
