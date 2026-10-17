// /positions: daftar trade terbuka, detail per trade (claim, TP/SL/Trail, close) dengan data live.
import { InlineKeyboard } from "grammy";
import log from "../core/logger.js";
import { getOpenPositions } from "../meteora/positions.js";
import { aggregateTradePnl } from "../exit/trade-exit.js";
import { claimTrade } from "../lp/claim.js";
import { closeTrade } from "../lp/close-trade.js";
import { canFlip, flipTrade, planFlip } from "../lp/flip-trade.js";
import { getTrackedPosition } from "../state/positions.js";
import { getTrade, listOpenTrades, setTradeAutoFlip, setTradeExit, setTradePanda } from "../state/trades.js";
import { registerConfirm, registerPrompt, withGuard } from "./bot.js";
import { esc, exitSummary, fmtAge, fmtPct, fmtSol, fmtToken, fmtUsd, fmtWib, shortAddr } from "./format.js";
import { parseAutoFlipInput, parseExitInput } from "./parse.js";
import * as session from "./session.js";

const HTML = { parse_mode: "HTML" };
// Semua layar satu trade diawali ini; tombol Back dari layar itu mengedit pesan (bukan kirim baru).
const TRADE_PREFIX = "📂 Trade #";
const BUSY = "Busy — another action is running on this trade";

// Dependensi yang bisa diganti tes.
export const deps = { getOpenPositions, claimTrade, closeTrade, planFlip, flipTrade };

const PROMPTS = {
  tp: (id) => `Send the Take Profit % for trade #${id} (e.g. 20), or off.`,
  sl: (id) => `Send the Stop Loss % for trade #${id} (e.g. 25), or off.`,
  trail: (id) => `Send the Trailing for trade #${id} as: start distance (e.g. 5 3), or off.`,
};

const finite = (n) => typeof n === "number" && Number.isFinite(n);
// Leg yang sudah tertutup di state tidak ikut PnL/range (sama dengan loop exit).
const isLegClosed = (addr) => getTrackedPosition(addr)?.closed === true;

// Posisi live → Map by alamat; null bila gagal (UI tampil "PnL ?").
async function loadLive() {
  try {
    const list = await deps.getOpenPositions();
    return Array.isArray(list) ? new Map(list.map((p) => [p.position, p])) : null;
  } catch (err) {
    log.warn(`Positions: data live gagal: ${err?.message ?? err}`);
    return null;
  }
}

// { pnlPct, pnlUsd, inRange, feesUsd, feesSol, valueUsd, valueSol, bins } untuk satu trade;
// field yang tidak diketahui = null. bins = { lower, upper, active } gabungan semua leg terbuka.
export function liveForTrade(trade, positionsByAddr) {
  const live = {
    pnlPct: null,
    pnlUsd: null,
    inRange: null,
    feesUsd: null,
    feesSol: null,
    valueUsd: null,
    valueSol: null,
    bins: null,
  };
  if (!positionsByAddr) return live;
  const agg = aggregateTradePnl(trade, positionsByAddr, { isClosed: isLegClosed });
  if (agg) {
    live.pnlPct = agg.pnlPct;
    live.pnlUsd = agg.pnlUsd;
    live.valueUsd = agg.depositUsd + agg.pnlUsd;
  }
  let outside = false;
  let missing = false;
  let openLegs = 0;
  const sum = { feesUsd: 0, feesSol: 0, valueSol: 0 };
  const known = { feesUsd: true, feesSol: true, valueSol: true };
  const add = (key, v) => (finite(v) ? (sum[key] += v) : (known[key] = false));
  let lower = Infinity;
  let upper = -Infinity;
  let active = null;
  let binStep = null;
  let xIsSol = false;
  for (const addr of trade.positions || []) {
    if (isLegClosed(addr)) continue;
    openLegs++;
    const p = positionsByAddr.get(addr);
    add("feesUsd", p?.unclaimedFeeUsd);
    add("feesSol", p?.unclaimedFee);
    add("valueSol", p?.valueSol);
    if (!p || !finite(p.activeBin) || !finite(p.lowerBin) || !finite(p.upperBin)) {
      missing = true;
      continue;
    }
    if (p.activeBin < p.lowerBin || p.activeBin > p.upperBin) outside = true;
    lower = Math.min(lower, p.lowerBin);
    upper = Math.max(upper, p.upperBin);
    active = p.activeBin;
    binStep = finite(p.binStep) && p.binStep > 0 ? p.binStep : null;
    xIsSol = p.xIsSol === true;
  }
  if (outside) live.inRange = false;
  else if (!missing && openLegs > 0) live.inRange = true;
  if (openLegs > 0) {
    for (const key of Object.keys(sum)) if (known[key]) live[key] = sum[key];
  }
  // Fee USD tidak ada di respons → konversi fee SOL dengan harga SOL tersirat dari nilai trade.
  if (live.feesUsd == null && finite(live.feesSol) && finite(live.valueUsd) && live.valueSol > 0) {
    live.feesUsd = live.feesSol * (live.valueUsd / live.valueSol);
  }
  if (!missing && openLegs > 0) live.bins = { lower, upper, active, binStep, xIsSol };
  return live;
}

function liveById(trades, positionsByAddr) {
  return new Map(trades.map((t) => [t.id, liveForTrade(t, positionsByAddr)]));
}

// "#12 BONK-SOL · spot · 0.5 SOL · +4.20% ($3.10) · in range · TP15 SL-25 T5/3"
export function tradeLine(trade, live) {
  const parts = [`#${trade.id} ${trade.pair}`, trade.shape ?? trade.origin];
  if (finite(trade.depositSol)) parts.push(fmtSol(trade.depositSol));
  parts.push(
    finite(live?.pnlPct) && finite(live?.pnlUsd) ? `${fmtPct(live.pnlPct)} (${fmtUsd(live.pnlUsd)})` : "PnL ?"
  );
  if (live?.inRange === true) parts.push("in range");
  else if (live?.inRange === false) parts.push("out of range");
  parts.push(exitSummary(trade.exit));
  return parts.join(" · ");
}

export function buildPositionsList(trades, liveByTradeId) {
  if (trades.length === 0) {
    return { text: "No open positions.", keyboard: new InlineKeyboard().text("➕ Open", "home:open") };
  }
  const keyboard = new InlineKeyboard();
  const lines = [];
  for (const t of trades) {
    const live = liveByTradeId.get(t.id);
    lines.push(esc(tradeLine(t, live)));
    const pnl = finite(live?.pnlPct) ? ` ${fmtPct(live.pnlPct)}` : "";
    keyboard.text(`#${t.id} ${t.pair}${pnl}`, `pos:open:${t.id}`).row();
  }
  keyboard.text("🔄 Refresh", "home:positions");
  return { text: [`📂 Open positions (${trades.length})`, "", ...lines].join("\n"), keyboard };
}

// "Range -45% / +10%". Harga SOL tidak ditampilkan: binStep/desimal tidak disimpan di trade.
function rangeLine(range) {
  if (!range || !finite(range.below) || !finite(range.above)) return "Range ?";
  return `Range -${range.below}% / +${range.above}%`;
}

// Label tombol exit berisi nilainya: "🎯 TP 15%", "🛑 SL -25%", "📈 Trail 5/3", atau "off".
function exitButtons(exit) {
  const { tp, sl, trail } = exit || {};
  return {
    tp: `🎯 TP ${tp?.on ? `${tp.pct}%` : "off"}`,
    sl: `🛑 SL ${sl?.on ? `-${sl.pct}%` : "off"}`,
    trail: `📈 Trail ${trail?.on ? `${trail.startPct}/${trail.distancePct}` : "off"}`,
  };
}

const BAR_WIDTH = 12;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const bar = (frac) => {
  const filled = Math.round(Math.min(1, Math.max(0, frac)) * BAR_WIDTH);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
};

// Posisi harga token sekarang di dalam range, dalam harga (bukan bin):
// in range → "[█████░░░░░░░] min -12.30% · max +8.10%" (jarak harga batas dari harga sekarang);
// di luar → "[████████████] 5.00% above range" (jarak harga sekarang dari batas terdekat).
// Tanpa binStep (harga tidak bisa dihitung) → fallback dalam bin.
export function rangeBar(bins) {
  if (!bins || !finite(bins.lower) || !finite(bins.upper) || !finite(bins.active)) return null;
  const { lower, upper, active, binStep, xIsSol } = bins;
  // Harga token naik searah bin id, kecuali SOL = token X (harga pool = token per SOL).
  const dir = xIsSol ? -1 : 1;
  const [minBin, maxBin] = dir > 0 ? [lower, upper] : [upper, lower];
  // Jarak (dalam bin, searah harga token) dari batas range ke harga sekarang.
  const belowBins = dir * (minBin - active);
  const aboveBins = dir * (active - maxBin);
  const hasPrice = finite(binStep) && binStep > 0;
  // Persen harga untuk n bin searah harga token.
  const pctFor = (n) => (Math.pow(1 + binStep / 10000, n) - 1) * 100;
  const abs = (pct) => fmtPct(pct).slice(1);
  if (belowBins > 0) {
    return `${bar(0)} ${hasPrice ? abs(-pctFor(-belowBins)) : plural(belowBins, "bin")} below range`;
  }
  if (aboveBins > 0) {
    return `${bar(1)} ${hasPrice ? abs(pctFor(aboveBins)) : plural(aboveBins, "bin")} above range`;
  }
  const span = upper - lower;
  const frac = span === 0 ? 1 : -belowBins / span;
  if (!hasPrice) return `${bar(frac)} ${Math.round(frac * 100)}% from min`;
  return `${bar(frac)} min ${fmtPct(pctFor(belowBins))} · max ${fmtPct(pctFor(-aboveBins))}`;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Nama pair sebagai link chart GMGN bila mint token diketahui.
function pairLink(trade) {
  const name = esc(trade.pair);
  return BASE58.test(trade.baseMint ?? "") ? `<a href="https://gmgn.ai/sol/token/${trade.baseMint}">${name}</a>` : name;
}

function statusTag(inRange) {
  if (inRange === true) return "🟢 IN";
  if (inRange === false) return "🔴 OUT";
  return "⚪ ?";
}

const withSol = (usd, sol) => (finite(sol) ? `${fmtUsd(usd)} (${fmtSol(sol)})` : fmtUsd(usd));

export function buildTradeDetail(trade, live, now = Date.now()) {
  const legs = (trade.positions || []).length;
  const age = finite(trade.openedAt) ? fmtAge(now - trade.openedAt) : "?";
  const pnl = finite(live?.pnlPct) && finite(live?.pnlUsd) ? `${fmtUsd(live.pnlUsd)} (${fmtPct(live.pnlPct)})` : "?";
  const deposit = finite(trade.depositSol) ? ` · deposit ${fmtSol(trade.depositSol)}` : "";
  const text = [
    `${TRADE_PREFIX}${trade.id}`,
    "",
    `${statusTag(live?.inRange)} · ${pairLink(trade)} · ${age} · ${withSol(live?.valueUsd, live?.valueSol)}`,
    `PnL ${pnl} · fees ${withSol(live?.feesUsd, live?.feesSol)}`,
    [trade.shape, rangeLine(trade.range)].filter(Boolean).map(esc).join(" · "),
    rangeBar(live?.bins),
    "",
    `Peak PnL ${fmtPct(trade.peakPnlPct)}`,
    trade.exit?.panda?.on && trade.panda?.armed ? "🐼 Evil Panda armed — waiting for a spike" : null,
    `Pool ${shortAddr(trade.pool)} · ${legs} position(s)${deposit}`,
    `Origin ${esc(trade.origin ?? "?")} · opened ${fmtWib(trade.openedAt)}`,
  ]
    .filter((line) => line != null)
    .join("\n");
  const id = trade.id;
  const exitLabel = exitButtons(trade.exit);
  const keyboard = new InlineKeyboard()
    .text("💰 Claim", `pos:claim:${id}`)
    .text("💰 Claim+swap", `pos:claimswap:${id}`)
    .row()
    .text(exitLabel.tp, `pos:tp:${id}`)
    .text(exitLabel.sl, `pos:sl:${id}`)
    .text(exitLabel.trail, `pos:trail:${id}`)
    .row()
    .text(`🐼 Panda ${trade.exit?.panda?.on ? "on" : "off"}`, `pos:panda:${id}`)
    .row()
    .text("❌ Close", `pos:close:${id}`);
  if (canFlip(trade)) {
    const auto = trade.autoFlip?.pct > 0 ? `${trade.autoFlip.pct}%` : "off";
    keyboard.text("🔁 Flip", `pos:flip:${id}`).text(`🤖 Auto flip ${auto}`, `pos:autoflip:${id}`);
  }
  keyboard.row().text("🔄 Refresh", `pos:open:${id}`).text("◀ Back", "home:positions");
  return { text, keyboard };
}

// Untuk kartu home dan /pnl: jumlah trade terbuka + Σ PnL USD trade yang PnL-nya diketahui
// (null = tidak ada yang diketahui; partial = ada trade terbuka yang PnL-nya tidak diketahui).
export async function summarizeOpenTrades() {
  const trades = listOpenTrades();
  if (trades.length === 0) return { count: 0, pnlUsd: 0, partial: false };
  const live = await loadLive();
  let sum = 0;
  let known = 0;
  if (live) {
    for (const t of trades) {
      const agg = aggregateTradePnl(t, live, { isClosed: isLegClosed });
      if (agg) {
        sum += agg.pnlUsd;
        known++;
      }
    }
  }
  return { count: trades.length, pnlUsd: known > 0 ? sum : null, partial: known < trades.length };
}

// "message is not modified" (mis. Refresh tanpa perubahan) bukan error.
async function editSafe(ctx, text, extra) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (/not modified/i.test(String(err?.description ?? err?.message ?? ""))) return;
    throw err;
  }
}

// Preview link dimatikan: link chart di detail trade tidak boleh memunculkan kartu GMGN.
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

const show = (ctx, edit, text, keyboard) =>
  edit
    ? editSafe(ctx, text, { ...HTML, ...NO_PREVIEW, reply_markup: keyboard })
    : ctx.reply(text, { ...HTML, ...NO_PREVIEW, reply_markup: keyboard });

async function showList(ctx, edit) {
  const trades = listOpenTrades();
  const live = trades.length ? await loadLive() : null;
  const { text, keyboard } = buildPositionsList(trades, liveById(trades, live));
  await show(ctx, edit, text, keyboard);
}

function openTradeOrNull(id) {
  const trade = getTrade(id);
  return trade && trade.closed !== true ? trade : null;
}

async function notOpen(ctx, id) {
  await ctx.reply(`Trade #${id} is not open anymore.`);
}

async function showDetail(ctx, trade, edit) {
  const live = await loadLive();
  const { text, keyboard } = buildTradeDetail(trade, liveForTrade(trade, live));
  await show(ctx, edit, text, keyboard);
}

const screen = (id, line) => `${TRADE_PREFIX}${id}\n\n${line}`;

const resultKeyboard = (id) =>
  new InlineKeyboard().text("🔄 Refresh", `pos:open:${id}`).text("◀ Back", "home:positions");

// Tampilkan progres, jalankan aksi, lalu ganti pesan dengan hasilnya.
async function runAction(ctx, id, { progress, label, work, describe }) {
  await editSafe(ctx, screen(id, progress), HTML);
  let line;
  try {
    line = describe(await work());
  } catch (err) {
    log.error(`Positions: ${label} trade #${id} gagal: ${err?.stack || err}`);
    line = `⚠️ ${label} failed: ${esc(String(err?.message ?? err).split("\n")[0])}`;
  }
  const extra = { ...HTML, reply_markup: resultKeyboard(id) };
  try {
    await editSafe(ctx, screen(id, line), extra);
  } catch (err) {
    // Aksi sudah jalan: jangan sampai tampil "⚠️ ... failed" — kirim hasilnya sebagai pesan baru.
    log.warn(`Positions: edit hasil ${label} trade #${id} gagal: ${err?.message ?? err}`);
    await ctx.reply(screen(id, line), extra);
  }
}

function swapLine(swapInfo, requested) {
  if (!requested) return null;
  if (!swapInfo) return "Nothing to swap.";
  return swapInfo.success ? "Swapped to SOL." : `Swap failed: ${esc(swapInfo.error)} — the token stays in your wallet.`;
}

function describeClaim(res, swap) {
  if (res.busy) return BUSY;
  if (res.error) return `⚠️ Could not claim: ${esc(res.error)}`;
  const lines = [];
  if (res.failed.length === 0) lines.push(`✅ Claimed fees from ${res.claimed} position(s).`);
  else {
    lines.push(
      `⚠️ Claimed ${res.claimed} position(s). ${res.failed.length} position(s) could not be claimed ` +
        "(they may have no fees yet — see logs)."
    );
  }
  lines.push(swapLine(res.swapInfo, swap && res.claimed > 0));
  return lines.filter(Boolean).join("\n");
}

function describeClose(res, id, swap) {
  if (res.busy) return BUSY;
  if (!res.success) {
    const n = res.failed?.length ?? 0;
    return [
      `⚠️ ${n} position(s) could not be closed — the trade stays open, try again.`,
      swapLine(res.swapInfo, res.swapInfo != null),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [`✅ Trade #${id} closed.`, swapLine(res.swapInfo, swap)].filter(Boolean).join("\n");
}

const NOTHING_TO_FLIP = "Nothing to flip — no token-only bins yet.";

function describeFlip(res) {
  if (res.busy) return BUSY;
  const n = res.binCount;
  if (res.dryRun) return `🧪 DRY RUN — would flip ${n} bins → new position over ${n} bins.`;
  if (res.redepositFailed) return "⚠️ Withdrawn but re-deposit failed — token kept in wallet.";
  if (!res.success && n === 0 && !res.error) return NOTHING_TO_FLIP;
  if (!res.success) return `⚠️ Could not flip: ${esc(res.error ?? "unknown error")}`;
  return `✅ Flipped ${n} bins (${fmtToken(res.tokenAmount)} token) → new position over ${n} bins.`;
}

export function register(bot) {
  bot.command(
    "positions",
    withGuard("/positions", (ctx) => showList(ctx, false))
  );

  bot.callbackQuery(
    "home:positions",
    withGuard("Positions", (ctx) => showList(ctx, ctx.callbackQuery.message?.text?.startsWith(TRADE_PREFIX) === true))
  );

  bot.callbackQuery(
    /^pos:open:(\d+)$/,
    withGuard("Position", async (ctx) => {
      const id = Number(ctx.match[1]);
      const trade = openTradeOrNull(id);
      if (!trade) return notOpen(ctx, id);
      await showDetail(ctx, trade, true);
    })
  );

  bot.callbackQuery(
    /^pos:(claim|claimswap):(\d+)$/,
    withGuard("Claim", async (ctx) => {
      const swap = ctx.match[1] === "claimswap";
      const id = Number(ctx.match[2]);
      const trade = openTradeOrNull(id);
      if (!trade) return notOpen(ctx, id);
      await runAction(ctx, id, {
        progress: swap ? "⏳ Claiming and swapping…" : "⏳ Claiming…",
        label: "Claim",
        work: () => deps.claimTrade(trade, { swap }),
        describe: (res) => describeClaim(res, swap),
      });
    })
  );

  bot.callbackQuery(
    /^pos:(tp|sl|trail):(\d+)$/,
    withGuard("Exit edit", async (ctx) => {
      const field = ctx.match[1];
      const id = Number(ctx.match[2]);
      if (!openTradeOrNull(id)) return notOpen(ctx, id);
      session.put("prompt", { kind: "pos-exit", id, field });
      await ctx.reply(PROMPTS[field](id));
    })
  );

  bot.callbackQuery(
    /^pos:panda:(\d+)$/,
    withGuard("Evil Panda", async (ctx) => {
      const id = Number(ctx.match[1]);
      const trade = openTradeOrNull(id);
      if (!trade) return notOpen(ctx, id);
      setTradePanda(id, trade.exit?.panda?.on !== true);
      await showDetail(ctx, getTrade(id), true);
    })
  );

  bot.callbackQuery(
    /^pos:autoflip:(\d+)$/,
    withGuard("Auto flip", async (ctx) => {
      const id = Number(ctx.match[1]);
      const trade = openTradeOrNull(id);
      if (!trade) return notOpen(ctx, id);
      if (!canFlip(trade)) return;
      session.put("prompt", { kind: "pos-autoflip", id });
      await ctx.reply(`Send the Auto flip % for trade #${id} (e.g. 30), or off.`);
    })
  );

  registerPrompt("pos-autoflip", async (ctx, prompt) => {
    const parsed = parseAutoFlipInput(ctx.message.text);
    if (!parsed) {
      await ctx.reply("Invalid value, try again");
      return;
    }
    session.del("prompt");
    const trade = openTradeOrNull(prompt.id);
    if (!trade) return notOpen(ctx, prompt.id);
    setTradeAutoFlip(trade.id, parsed.on ? { pct: parsed.pct } : null);
    await showDetail(ctx, getTrade(trade.id), false);
  });

  registerPrompt("pos-exit", async (ctx, prompt) => {
    const parsed = parseExitInput(prompt.field, ctx.message.text);
    if (!parsed) {
      await ctx.reply("Invalid value, try again");
      return;
    }
    session.del("prompt");
    const trade = openTradeOrNull(prompt.id);
    if (!trade) return notOpen(ctx, prompt.id);
    setTradeExit(trade.id, { [prompt.field]: parsed });
    await showDetail(ctx, getTrade(trade.id), false);
  });

  bot.callbackQuery(
    /^pos:close:(\d+)$/,
    withGuard("Close", async (ctx) => {
      const id = Number(ctx.match[1]);
      const trade = openTradeOrNull(id);
      if (!trade) return notOpen(ctx, id);
      const keyboard = new InlineKeyboard()
        .text("Close + swap to SOL", `ok:${session.issueToken({ action: "close", id, swap: true })}`)
        .row()
        .text("Close only", `ok:${session.issueToken({ action: "close", id, swap: false })}`)
        .row()
        .text("Cancel", `pos:open:${id}`);
      const legs = trade.positions.length;
      await editSafe(ctx, screen(id, `Close ${esc(trade.pair)}? This closes ${legs} position(s).`), {
        ...HTML,
        reply_markup: keyboard,
      });
    })
  );

  registerConfirm("close", async (ctx, payload) => {
    const trade = openTradeOrNull(payload.id);
    if (!trade) return notOpen(ctx, payload.id);
    await runAction(ctx, trade.id, {
      progress: "⏳ Closing…",
      label: "Close",
      work: async () => {
        const live = await loadLive();
        return deps.closeTrade(trade, { reason: "manual", swap: payload.swap, positionsByAddr: live ?? new Map() });
      },
      describe: (res) => describeClose(res, trade.id, payload.swap),
    });
  });

  bot.callbackQuery(
    /^pos:flip:(\d+)$/,
    withGuard("Flip", async (ctx) => {
      const id = Number(ctx.match[1]);
      const trade = openTradeOrNull(id);
      if (!trade) return notOpen(ctx, id);
      let plan;
      try {
        plan = await deps.planFlip(trade);
      } catch (err) {
        log.error(`Positions: rencana flip trade #${id} gagal: ${err?.stack || err}`);
        plan = { error: String(err?.message ?? err).split("\n")[0] };
      }
      const result = (line) => editSafe(ctx, screen(id, line), { ...HTML, reply_markup: resultKeyboard(id) });
      if (plan.error) return result(`⚠️ Could not flip: ${esc(plan.error)}`);
      if (!(plan.binCount > 0)) return result(NOTHING_TO_FLIP);
      const n = plan.binCount;
      const keyboard = new InlineKeyboard()
        .text("Flip", `ok:${session.issueToken({ action: "flip", id })}`)
        .row()
        .text("Cancel", `pos:open:${id}`);
      await editSafe(ctx, screen(id, `Flip ${n} bins → new token position over ${n} bins above price.`), {
        ...HTML,
        reply_markup: keyboard,
      });
    })
  );

  registerConfirm("flip", async (ctx, payload) => {
    const trade = openTradeOrNull(payload.id);
    if (!trade) return notOpen(ctx, payload.id);
    await runAction(ctx, trade.id, {
      progress: "⏳ Flipping…",
      label: "Flip",
      work: () => deps.flipTrade(trade),
      describe: describeFlip,
    });
  });
}
