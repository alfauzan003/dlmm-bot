// Runner live Auto Entry: screener Meteora -> sinyal -> batas -> open (live) atau paper (DRY_RUN).
// Semua I/O lewat deps agar tes tidak menyentuh jaringan, wallet, atau transaksi.
import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { isOn, setToggle } from "../state/settings.js";
import { listOpenTrades, listClosedTrades } from "../state/trades.js";
import { recordAction, getEntryInProgressMints, isEntryInProgressPool } from "../entry/runtime.js";
import { planOpen, executeOpen, SOL_BUFFER } from "../lp/open-trade.js";
import { fetchCandles } from "../market/candles.js";
import { getPrice } from "../market/jupiter-price.js";
import { WSOL_MINT } from "../core/constants.js";
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
} from "./screen.js";
import { entrySignal, pickRangePct, barsNeeded } from "./signal.js";
import { canOpen, todayAutoPnlSol, brakeHit } from "./limits.js";
import { fetchPoolRows, fetchTokens, countPoolLps } from "./sources.js";

// Runtime-only (reset saat restart): kegagalan entry per base mint, catatan dry run, snapshot.
const failures = new Map(); // mint -> { count, until }
const dryRunNoted = new Set();
const snapshots = new Map(); // profile -> Snapshot[]
let scanning = false;

// Seam khusus tes.
export function _resetRunnerForTest() {
  failures.clear();
  dryRunNoted.clear();
  snapshots.clear();
  scanning = false;
}

function withDeps(deps = {}) {
  return {
    fetchPoolRows,
    fetchTokens,
    fetchCandles,
    countPoolLps,
    planOpen,
    executeOpen,
    openPaperTrade: null,
    listOpenTrades,
    listClosedTrades,
    getSolBalance: async () => (await getConnection().getBalance(getWallet().publicKey)) / 1e9,
    notify: tg.notifyAutoEntry,
    notifyEntryFailed: tg.notifyEntryFailed,
    notifyEntryAborted: tg.notifyEntryAborted,
    notifyDailyBrake: tg.notifyDailyBrake,
    getSolUsd: () => getPrice(WSOL_MINT),
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

// Ref close trade auto sejak sinceMs. DRY_RUN: kosong sampai paper trade ada.
function closedRefs(d, sinceMs) {
  if (d.dryRun) return [];
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

// Ref trade auto untuk canOpen. DRY_RUN: kosong sampai paper trade ada.
function tradeRefs(d, now, g) {
  if (d.dryRun) return { open: [], closed: [] };
  const sinceMs = now - Math.max(g.cooldownMin, g.cooldownLossMin) * 60000;
  return {
    open: d
      .listOpenTrades()
      .filter(isAuto)
      .map((t) => ({ profile: t.strategy.profile, baseMint: t.baseMint })),
    closed: closedRefs(d, sinceMs),
  };
}

// Rem rugi harian: true bila batas kena -> scan berhenti. Gagal hitung PnL = fail open (scan lanjut);
// begitu batas kena, selalu true walau aksi (matikan toggle / alert) gagal.
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
        log.warn(`Auto entry: harga SOL gagal: ${err.message} — close USD-only dilewati di rem harian`);
      }
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

// Scan satu profil. Error API -> warn, profil/kandidat dilewati scan ini (sisanya ditangkap runScan).
export async function scanProfile(name, { deps } = {}) {
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
    return { candidates, opened };
  }
  rows = pickPoolPerToken(rows.filter((r) => passesPoolFilters(r, p, now).ok && coversMinRange(r.binStep, p)));

  // 2. Batas (trade auto terbuka / cooldown) + kegagalan entry; ambil N teratas.
  const refs = tradeRefs(d, now, g);
  const inProgress = getEntryInProgressMints();
  rows = rows
    .filter(
      (r) =>
        canOpen({ p, open: refs.open, closed: refs.closed, mint: r.baseMint, now, g }).ok &&
        !failureBlocked(r.baseMint, now) &&
        !inProgress.has(r.baseMint) &&
        !isEntryInProgressPool(r.address)
    )
    .slice(0, g.candidatesPerScan);
  if (rows.length === 0) return { candidates, opened };

  // 3. Info token Jupiter.
  let tokens;
  try {
    tokens = await d.fetchTokens(rows.map((r) => r.baseMint));
  } catch (err) {
    log.warn(`Auto entry ${name}: info token gagal: ${err.message} — profil dilewati`);
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
    };
    candidates.push(snap);

    const tok = passesTokenFilters(tokens.get(row.baseMint), g);
    if (!tok.ok) {
      snap.signal = tok.reason;
      continue;
    }

    // 4. Candle 5m tertutup -> volatilitas -> sinyal -> LP -> range.
    let bars;
    try {
      const candles = await d.fetchCandles(row.baseMint, row.address, { resolution: "5m", limit: barsNeeded(p) + 1 });
      bars = closedBars(candles || [], now);
    } catch (err) {
      log.warn(`Auto entry ${name}: candle ${pair} gagal: ${err.message}`);
      snap.signal = "no_candles";
      continue;
    }
    const vol = volatilityPct(bars);
    snap.volatilityPct = vol;
    if (!passesVolatility(vol, p)) {
      snap.signal = "volatility";
      continue;
    }
    const sig = entrySignal(bars, p);
    snap.signal = sig.reason;
    if (!sig.enter) continue;

    let lps = null;
    if (p.minLps > 0) {
      lps = await d.countPoolLps(row.address);
      if (lps == null || lps < p.minLps) {
        snap.signal = "lps";
        continue;
      }
    }
    const rangePct = pickRangePct(bars, p, row.binStep);
    if (rangePct == null) {
      snap.signal = "range";
      continue;
    }

    // 5. Cek ulang batas, termasuk open di scan ini.
    const check = canOpen({ p, open: [...refs.open, ...opened], closed: refs.closed, mint: row.baseMint, now, g });
    if (!check.ok) {
      snap.signal = check.reason;
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
        rangePct,
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
      continue;
    }
    // null = biaya non-refundable gagal dicek -> dilewati (fail closed).
    if (plan.nonRefundableSol == null || plan.nonRefundableSol > g.maxNonRefundableSol) {
      log.warn(`Auto entry ${name}: ${pair} dilewati: biaya non-refundable ${plan.nonRefundableSol ?? "?"} SOL`);
      snap.signal = "rent";
      continue;
    }
    if (plan.positionCount > p.maxPositions) {
      log.warn(`Auto entry ${name}: ${pair} dilewati: ${plan.positionCount} posisi > ${p.maxPositions}`);
      snap.signal = "positions";
      continue;
    }

    // Cek ulang tepat sebelum transaksi: toggle bisa OFF selama planOpen; /open manual bisa mulai di pool/mint ini.
    if (!d.isOn("autoEntry")) break;
    if (getEntryInProgressMints().has(row.baseMint) || isEntryInProgressPool(row.address)) {
      log.warn(`Auto entry ${name}: ${pair} dilewati: entry lain sedang berjalan`);
      snap.signal = "in_progress";
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
      });
      recordAction(`AUTO ENTRY ${plan.pair || pair} (${name}) — ${p.sizeSol} SOL −${rangePct.toFixed(0)}%`);
      continue;
    }

    const f = recordFailure(row, plan.pair || pair, res?.error || "unknown", now);
    snap.signal = "entry_failed";
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
      }
    }
  } finally {
    scanning = false;
  }
}

export function getScreenSnapshot() {
  return PROFILES.flatMap((name) => snapshots.get(name) || []);
}

export function startRunner() {
  const sec = Number(config.autoEntry.scanIntervalSec) > 0 ? Number(config.autoEntry.scanIntervalSec) : 60;
  const on = PROFILES.filter((n) => config.autoEntry.profiles[n]?.on);
  log.info(`Auto entry runner started — scan ${sec}s | profil: ${on.join(", ") || "tidak ada"}`);
  const tick = () => runScan().catch((err) => log.error(`Auto entry scan gagal: ${err.message}`));
  tick();
  const timer = setInterval(tick, sec * 1000);
  return { timer };
}
