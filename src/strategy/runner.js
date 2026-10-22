// Runner live Auto Entry: screener Meteora -> sinyal -> batas -> open (live) atau paper (DRY_RUN).
// Semua I/O lewat deps agar tes tidak menyentuh jaringan, wallet, atau transaksi.
import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { isOn, setToggle } from "../state/settings.js";
import { listOpenTrades, listClosedTrades } from "../state/trades.js";
import { recordAction, getEntryInProgressMints, isEntryInProgressPool } from "../entry/runtime.js";
import { planOpen, executeOpen, SOL_BUFFER } from "../lp/open-trade.js";
import { periodStart } from "../lp/pnl-stats.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { PROFILES, profileExit } from "./params.js";
import {
  poolQueryUrl,
  passesPoolFilters,
  pickPoolPerToken,
  coversMinRange,
  passesTokenFilters,
  closedBars,
  volatilityPct,
  passesVolatility,
  toSolPerToken,
} from "./screen.js";
import { entrySignal, explainRangePct, barsNeeded } from "./signal.js";
import { canOpen, todayAutoPnlSol, brakeHit } from "./limits.js";
import { fetchPoolRows, fetchTokens, fetchRecentBars, countPoolLps, getSolUsdForced } from "./sources.js";
import { openPaperTrade, listPaperTrades } from "./paper.js";
import {
  emptyFunnel,
  bump,
  tokenDetail,
  volatilityDetail,
  signalDetail,
  limitDetail,
  funnelLine,
  candidateLine,
  emptyDigest,
  addScan,
  buildDigestText,
} from "./scan-report.js";

// Runtime-only (reset saat restart): kegagalan entry per base mint, catatan dry run, snapshot, digest.
const failures = new Map(); // mint -> { count, until }
const dryRunNoted = new Set();
const snapshots = new Map(); // profile -> Snapshot[]
let scanning = false;
let digest = emptyDigest();
let digestAt = null; // waktu digest terakhir; null = kirim setelah scan pertama

// Seam khusus tes.
export function _resetRunnerForTest() {
  failures.clear();
  dryRunNoted.clear();
  snapshots.clear();
  scanning = false;
  digest = emptyDigest();
  digestAt = null;
}

function withDeps(deps = {}) {
  return {
    fetchPoolRows,
    fetchTokens,
    fetchRecentBars,
    countPoolLps,
    planOpen,
    executeOpen,
    openPaperTrade: (a) =>
      openPaperTrade({ profile: a.profile, p: a.p, row: a.row, rangePct: a.rangePct, entry: a.strategy.entry, deps: deps.paper }),
    listPaperTrades,
    listOpenTrades,
    listClosedTrades,
    getSolBalance: async () => (await getConnection().getBalance(getWallet().publicKey)) / 1e9,
    notify: tg.notifyAutoEntry,
    notifyEntryFailed: tg.notifyEntryFailed,
    notifyEntryAborted: tg.notifyEntryAborted,
    notifyDailyBrake: tg.notifyDailyBrake,
    notifyDigest: tg.notifyAutoDigest,
    getSolUsd: () => getSolUsdForced(),
    setToggle,
    isOn,
    now: Date.now,
    dryRun: config.dryRun,
    ...deps,
  };
}

function failureBlocked(mint, now) {
  const f = failures.get(mint);
  if (!f) return false;
  return f.count >= config.entry.maxFailures || now < f.until;
}

const isAuto = (t) => t?.origin === "auto" && t.strategy;

// Ref close trade auto sejak sinceMs. DRY_RUN: dari paper trade.
function closedRefs(d, sinceMs) {
  if (d.dryRun) {
    return d
      .listPaperTrades({ open: false })
      .filter((t) => t.closedAt >= sinceMs)
      .map((t) => ({ baseMint: t.baseMint, closedAt: t.closedAt, closePnlSol: t.closePnlSol }));
  }
  return d
    .listClosedTrades({ sinceMs })
    .filter(isAuto)
    .map((t) => ({
      baseMint: t.baseMint,
      closedAt: t.closedAt,
      closePnlUsd: t.closePnlUsd,
      closePnlSol: t.closePnlSol,
    }));
}

// Ref trade auto untuk canOpen. DRY_RUN: dari paper trade.
function tradeRefs(d, now, g) {
  const sinceMs = now - Math.max(g.cooldownMin, g.cooldownLossMin) * 60000;
  const open = d.dryRun
    ? d.listPaperTrades({ open: true }).map((t) => ({ profile: t.profile, baseMint: t.baseMint }))
    : d
        .listOpenTrades()
        .filter(isAuto)
        .map((t) => ({ profile: t.strategy.profile, baseMint: t.baseMint }));
  return { open, closed: closedRefs(d, sinceMs) };
}

// Rem rugi harian: true bila batas kena -> scan berhenti. Gagal hitung PnL = fail open (scan lanjut), kecuali
// ada close USD-only hari ini tanpa harga SOL -> true (scan ini dilewati, fail closed); begitu batas kena,
// selalu true walau aksi (matikan toggle / alert) gagal.
async function dailyBrake(deps) {
  const d = withDeps(deps);
  const g = config.autoEntry;
  let pnl;
  try {
    const now = d.now();
    const closed = closedRefs(d, periodStart("today", now));
    let solUsd = null;
    if (closed.length > 0) {
      try {
        solUsd = await d.getSolUsd();
      } catch (err) {
        log.warn(`Auto entry: harga SOL gagal: ${err.message}`);
      }
    }
    const usdOnly = closed.some((t) => !Number.isFinite(t.closePnlSol) && Number.isFinite(t.closePnlUsd));
    if (usdOnly && !(Number(solUsd) > 0)) {
      log.warn("Auto entry: harga SOL tidak ada untuk close USD-only — rem harian tidak bisa dihitung, scan dilewati");
      return true;
    }
    pnl = todayAutoPnlSol(closed, solUsd, now);
    if (!brakeHit(pnl, g)) return false;
  } catch (err) {
    log.warn(`Auto entry: cek rem rugi harian gagal: ${err.message}`);
    return false;
  }
  try {
    d.setToggle("autoEntry", false);
  } catch (err) {
    log.error(`Auto entry: gagal mematikan Auto Entry setelah rem rugi harian: ${err.message}`);
  }
  try {
    d.notifyDailyBrake({ pnlSol: pnl, limitSol: g.dailyLossLimitSol });
  } catch (err) {
    log.warn(`Auto entry: alert rem rugi harian gagal: ${err.message}`);
  }
  log.warn(`Auto entry: rem rugi harian kena (${pnl.toFixed(3)} SOL ≤ −${g.dailyLossLimitSol} SOL) — Auto Entry OFF`);
  return true;
}

function recordFailure(row, pair, error, now) {
  const mint = row.baseMint;
  const count = (failures.get(mint)?.count || 0) + 1;
  const max = config.entry.maxFailures;
  const cooldownSec = Math.max(0, Number(config.entry.failureCooldownSec) || 0);
  failures.set(mint, { count, until: now + cooldownSec * 1000 });
  return { count, max, cooldownSec, aborted: count >= max, pool: row.address, pair, error };
}

// Log keputusan scan (funnel + tiap kandidat) dan catat ke digest Telegram.
function reportScan(name, funnel, candidates) {
  log.info(funnelLine(name, funnel));
  for (const c of candidates) log.info(candidateLine(name, c));
  addScan(digest, name, funnel, candidates);
}

// Scan satu profil + laporan keputusan. Error API -> warn, profil/kandidat dilewati scan ini (sisanya ditangkap runScan).
export async function scanProfile(name, { deps } = {}) {
  const funnel = emptyFunnel();
  const res = await scanProfileOnce(name, { deps }, funnel);
  if (config.autoEntry.profiles[name]?.on) reportScan(name, funnel, res.candidates);
  return res;
}

async function scanProfileOnce(name, { deps } = {}, funnel) {
  const d = withDeps(deps);
  const g = config.autoEntry;
  const p = g.profiles[name];
  const candidates = [];
  const opened = [];
  snapshots.set(name, candidates);
  if (!p?.on) return { candidates, opened };
  const now = d.now();

  // 1. Daftar pool datapi -> filter -> satu pool per token.
  let rows;
  try {
    rows = await d.fetchPoolRows(poolQueryUrl(p, now));
  } catch (err) {
    log.warn(`Auto entry ${name}: daftar pool gagal: ${err.message} — profil dilewati`);
    funnel.error = `pool list failed: ${err.message}`;
    return { candidates, opened };
  }
  funnel.fetched = rows.length;
  rows = rows.filter((r) => {
    const f = passesPoolFilters(r, p, now);
    const reason = !f.ok ? f.reason : !coversMinRange(r.binStep, p) ? "min_range" : null;
    if (reason) bump(funnel.filtered, reason);
    return !reason;
  });
  funnel.passed = rows.length;
  rows = pickPoolPerToken(rows);
  funnel.tokens = rows.length;

  // 2. Batas (trade auto terbuka / cooldown) + kegagalan entry; ambil N teratas.
  const refs = tradeRefs(d, now, g);
  const inProgress = getEntryInProgressMints();
  rows = rows.filter((r) => {
    const c = canOpen({ p, open: refs.open, closed: refs.closed, mint: r.baseMint, now, g });
    let reason = null;
    if (!c.ok) reason = c.reason;
    else if (failureBlocked(r.baseMint, now)) reason = "failed";
    else if (inProgress.has(r.baseMint) || isEntryInProgressPool(r.address)) reason = "in_progress";
    if (reason) bump(funnel.limited, reason);
    return !reason;
  });
  if (rows.length > g.candidatesPerScan) funnel.limited.beyond_top = rows.length - g.candidatesPerScan;
  rows = rows.slice(0, g.candidatesPerScan);
  funnel.checked = rows.length;
  if (rows.length === 0) return { candidates, opened };

  // 3. Info token Jupiter.
  let tokens;
  try {
    tokens = await d.fetchTokens(rows.map((r) => r.baseMint));
  } catch (err) {
    log.warn(`Auto entry ${name}: info token gagal: ${err.message} — profil dilewati`);
    funnel.error = `token info failed: ${err.message}`;
    return { candidates, opened };
  }

  for (const row of rows) {
    const pair = row.name || `${row.baseMint.slice(0, 4)}-SOL`;
    const snap = {
      profile: name,
      pairName: row.name || null,
      pool: row.address,
      feeTvl30mPct: row.feeTvl30mPct,
      volatilityPct: null,
      signal: null,
      detail: null,
    };
    candidates.push(snap);

    const token = tokens.get(row.baseMint);
    const tok = passesTokenFilters(token, g);
    if (!tok.ok) {
      snap.signal = tok.reason;
      snap.detail = tokenDetail(tok.reason, token, g);
      continue;
    }

    // 4. Candle 5m tertutup -> volatilitas -> sinyal -> LP -> range.
    let bars;
    try {
      const raw = await d.fetchRecentBars(row.address, barsNeeded(p) + 1);
      if (!raw?.length) {
        snap.signal = "no_candles";
        snap.detail = "no 5m candles from Meteora";
        continue;
      }
      bars = closedBars(toSolPerToken(raw, row.baseIsX), now);
    } catch (err) {
      log.warn(`Auto entry ${name}: candle ${pair} gagal: ${err.message}`);
      snap.signal = "no_candles";
      snap.detail = `candles failed: ${err.message}`;
      continue;
    }
    const vol = volatilityPct(bars);
    snap.volatilityPct = vol;
    if (!passesVolatility(vol, p)) {
      snap.signal = "volatility";
      snap.detail = volatilityDetail(vol, p);
      continue;
    }
    const sig = entrySignal(bars, p);
    snap.signal = sig.reason;
    snap.detail = signalDetail(sig, p);
    if (!sig.enter) continue;
    const sigDetail = snap.detail;

    let lps = null;
    if (p.minLps > 0) {
      lps = await d.countPoolLps(row.address);
      if (lps == null || lps < p.minLps) {
        snap.signal = "lps";
        snap.detail = `LPs ${lps ?? "?"} < ${p.minLps}`;
        continue;
      }
    }
    const range = explainRangePct(bars, p, row.binStep);
    const rangePct = range.pct;
    if (rangePct == null) {
      snap.signal = "range";
      snap.detail = range.why;
      continue;
    }
    snap.detail = `${sigDetail} · range ${rangePct.toFixed(1)}% (${range.why})`;

    // 5. Cek ulang batas, termasuk open di scan ini.
    const check = canOpen({ p, open: [...refs.open, ...opened], closed: refs.closed, mint: row.baseMint, now, g });
    if (!check.ok) {
      snap.signal = check.reason;
      snap.detail = limitDetail(check.reason, p);
      continue;
    }

    const strategy = {
      profile: p.name,
      params: { ...p },
      entry: {
        metrics: {
          feeTvl30mPct: row.feeTvl30mPct,
          volume30mUsd: row.volume30mUsd,
          tvlUsd: row.tvlUsd,
          mcapUsd: row.mcapUsd,
          holders: row.holders,
          volatilityPct: vol,
          lps,
        },
        signal: { reason: sig.reason, ...(sig.metrics || {}) },
        signalWhy: sigDetail,
        rangePct,
        rangeWhy: range.why,
        poolMeta: {
          binStep: row.binStep,
          baseFeePct: row.baseFeePct,
          protocolFeePct: row.protocolFeePct,
          tvlUsd: row.tvlUsd,
        },
      },
    };

    if (d.dryRun) {
      if (d.openPaperTrade) {
        if (await d.openPaperTrade({ profile: name, p, row, bars, rangePct, strategy, now })) {
          opened.push({ profile: name, baseMint: row.baseMint });
          snap.signal = "paper_opened";
        }
      } else if (!dryRunNoted.has(row.baseMint)) {
        dryRunNoted.add(row.baseMint);
        log.info(`[DRY RUN] would open ${pair} (${name}) −${rangePct.toFixed(0)}%`);
      }
      continue;
    }

    // Auto Entry dimatikan di tengah scan: berhenti sebelum transaksi apa pun.
    if (!d.isOn("autoEntry")) break;

    // Saldo kurang bukan kegagalan entry: profil dilewati scan ini.
    let balance;
    try {
      balance = await d.getSolBalance();
    } catch (err) {
      log.warn(`Auto entry ${name}: cek saldo gagal: ${err.message} — profil dilewati`);
      break;
    }
    const need = p.sizeSol + config.entry.gasReserve + SOL_BUFFER;
    if (!(balance >= need)) {
      log.warn(`Auto entry ${name}: saldo ${Number(balance).toFixed(4)} SOL < ${need.toFixed(4)} SOL — profil dilewati`);
      snap.signal = "low_balance";
      snap.detail = `balance ${Number(balance).toFixed(4)} SOL < need ${need.toFixed(4)} SOL`;
      break;
    }

    let plan;
    try {
      plan = await d.planOpen({
        poolAddress: row.address,
        depositSol: p.sizeSol,
        below: rangePct,
        above: 0,
        shape: "bid_ask",
      });
    } catch (err) {
      plan = { error: err.message };
    }
    if (plan.error) {
      log.warn(`Auto entry ${name}: ${pair} dilewati: ${plan.error}`);
      snap.signal = "plan_error";
      snap.detail = plan.error;
      continue;
    }
    // null = biaya non-refundable gagal dicek -> dilewati (fail closed).
    if (plan.nonRefundableSol == null || plan.nonRefundableSol > g.maxNonRefundableSol) {
      log.warn(`Auto entry ${name}: ${pair} dilewati: biaya non-refundable ${plan.nonRefundableSol ?? "?"} SOL`);
      snap.signal = "rent";
      snap.detail = `non-refundable ${plan.nonRefundableSol ?? "?"} SOL > max ${g.maxNonRefundableSol} SOL`;
      continue;
    }
    if (plan.positionCount > p.maxPositions) {
      log.warn(`Auto entry ${name}: ${pair} dilewati: ${plan.positionCount} posisi > ${p.maxPositions}`);
      snap.signal = "positions";
      snap.detail = `${plan.positionCount} positions > max ${p.maxPositions}`;
      continue;
    }

    // Cek ulang tepat sebelum transaksi: toggle bisa OFF selama planOpen; /open manual bisa mulai di pool/mint ini.
    if (!d.isOn("autoEntry")) break;
    if (getEntryInProgressMints().has(row.baseMint) || isEntryInProgressPool(row.address)) {
      log.warn(`Auto entry ${name}: ${pair} dilewati: entry lain sedang berjalan`);
      snap.signal = "in_progress";
      snap.detail = "another entry is running on this token/pool";
      continue;
    }

    let res;
    try {
      res = await d.executeOpen(plan, {
        meta: { origin: "auto", exit: profileExit(p), autoFlip: { pct: p.flipPct }, strategy },
      });
    } catch (err) {
      res = { success: false, error: err.message };
    }

    // 6. Hasil: alert + aksi, atau hitung kegagalan per mint.
    if (res?.success) {
      failures.delete(row.baseMint);
      opened.push({ profile: name, baseMint: row.baseMint });
      snap.signal = "opened";
      if (res.warning) log.warn(`Auto entry ${plan.pair || pair}: ${res.warning}`);
      d.notify({
        profile: name,
        pair: plan.pair || pair,
        pool: row.address,
        sizeSol: p.sizeSol,
        rangePct,
        binStep: row.binStep,
        baseFeePct: row.baseFeePct,
        feeTvl30mPct: row.feeTvl30mPct,
        volatilityPct: vol,
        mcapUsd: row.mcapUsd,
        signalDetail: sigDetail,
        rangeWhy: range.why,
      });
      recordAction(`AUTO ENTRY ${plan.pair || pair} (${name}) — ${p.sizeSol} SOL −${rangePct.toFixed(0)}%`);
      continue;
    }

    const f = recordFailure(row, plan.pair || pair, res?.error || "unknown", now);
    snap.signal = "entry_failed";
    snap.detail = `${f.error} (attempt ${f.count}/${f.max})`;
    if (f.aborted) {
      log.error(`Auto entry ${f.pair}: gagal ${f.count}x — token diblokir sampai restart`);
      d.notifyEntryAborted({ pool: f.pool, pair: f.pair, attempts: f.count, error: f.error });
    } else {
      log.warn(`Auto entry ${f.pair} gagal (${f.count}/${f.max}): ${f.error} — cooldown ${f.cooldownSec}s`);
      d.notifyEntryFailed({
        pool: f.pool,
        pair: f.pair,
        error: f.error,
        attempts: f.count,
        maxFailures: f.max,
        cooldownSec: f.cooldownSec,
      });
    }
  }
  return { candidates, opened };
}

// Satu putaran scan semua profil aktif. Langsung kembali bila Auto Entry OFF atau scan masih jalan.
export async function runScan({ deps } = {}) {
  const on = deps?.isOn ?? isOn;
  if (!on("autoEntry")) {
    snapshots.clear();
    digest = emptyDigest();
    digestAt = null;
    return;
  }
  if (scanning) return;
  scanning = true;
  try {
    // Rem rugi harian (AUTO_DAILY_LOSS_LIMIT_SOL): cek sebelum profil di-scan.
    if (await dailyBrake(deps)) return;

    for (const name of PROFILES) {
      if (!on("autoEntry")) break;
      if (!config.autoEntry.profiles[name]?.on) {
        snapshots.delete(name);
        continue;
      }
      try {
        await scanProfile(name, { deps });
      } catch (err) {
        log.warn(`Auto entry ${name}: scan gagal: ${err.message}`);
        addScan(digest, name, { ...emptyFunnel(), error: `scan failed: ${err.message}` }, []);
      }
    }
    sendDigestIfDue(deps);
  } finally {
    scanning = false;
  }
}

// Digest Telegram: sekali setelah scan pertama (Auto Entry ON / restart), lalu tiap TG_STATUS_INTERVAL menit.
function sendDigestIfDue(deps) {
  const d = withDeps(deps);
  const now = d.now();
  const intervalMs = (Number(config.tgStatusInterval) > 0 ? Number(config.tgStatusInterval) : 5) * 60000;
  if (digestAt != null && now - digestAt < intervalMs) return;
  const text = buildDigestText(digest, {
    mode: d.dryRun ? "DRY RUN" : "LIVE",
    minutes: digestAt == null ? null : (now - digestAt) / 60000,
    profilesOn: PROFILES.filter((n) => config.autoEntry.profiles[n]?.on),
  });
  digest = emptyDigest();
  digestAt = now;
  try {
    d.notifyDigest(text);
  } catch (err) {
    log.warn(`Auto entry: digest Telegram gagal: ${err.message}`);
  }
}

export function getScreenSnapshot() {
  return PROFILES.flatMap((name) => snapshots.get(name) || []);
}

export function startRunner() {
  const sec = Number(config.autoEntry.scanIntervalSec) > 0 ? Number(config.autoEntry.scanIntervalSec) : 60;
  const on = PROFILES.filter((n) => config.autoEntry.profiles[n]?.on);
  log.info(`Auto entry runner started — scan ${sec}s | profil: ${on.join(", ") || "tidak ada"}`);
  tg.notifyRunnerStarted({
    mode: config.dryRun ? "DRY RUN" : "LIVE",
    scanSec: sec,
    profiles: on,
    autoEntryOn: isOn("autoEntry"),
    digestMin: config.tgStatusInterval,
  });
  const tick = () => runScan().catch((err) => log.error(`Auto entry scan gagal: ${err.message}`));
  tick();
  const timer = setInterval(tick, sec * 1000);
  return { timer };
}
