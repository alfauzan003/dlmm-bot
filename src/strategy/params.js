// Parameter strategi Auto Entry: satu strategi bidask flip (Fibonacci) + global. Rabbit menyusul.
// Semua dibaca dari peta env (strat.conf) dengan prefix per strategi.
import { bool, num } from "../config/env.js";

export const FLIP_MODES = ["pingpong", "pct"];

export const PROFILES = ["bidask_flip"];
export const PROFILE_PREFIX = { bidask_flip: "BIDASK" };

// Urutan = urutan di strat.conf.
export const PROFILE_FIELDS = [
  { suffix: "ON", field: "on", type: "bool" },
  // Screener (pool-discovery Meteora, timeframe 30m).
  { suffix: "MIN_MCAP_USD", field: "minMcapUsd", type: "num" },
  { suffix: "MAX_MCAP_USD", field: "maxMcapUsd", type: "num" },
  { suffix: "MIN_TOKEN_AGE_H", field: "minTokenAgeH", type: "num" },
  { suffix: "MAX_TOKEN_AGE_H", field: "maxTokenAgeH", type: "num" },
  { suffix: "MIN_HOLDERS", field: "minHolders", type: "int" },
  { suffix: "MAX_TOP10_PCT", field: "maxTop10Pct", type: "num" },
  { suffix: "MIN_FEES_30M_USD", field: "minFees30mUsd", type: "num" },
  { suffix: "MIN_BASE_FEE_PCT", field: "minBaseFeePct", type: "num" },
  { suffix: "MIN_FEE_ACTIVE_TVL_30M_PCT", field: "minFeeActiveTvl30mPct", type: "num" },
  { suffix: "MIN_BIN_STEP", field: "minBinStep", type: "int" },
  { suffix: "JUPSHIELD_SAFEGUARD", field: "jupShieldSafeguard", type: "bool" },
  // Entry & range (Fibonacci ATL -> ATH).
  { suffix: "FIB_ENTRY_LEVEL", field: "fibEntryLevel", type: "num" },
  { suffix: "FIB_DEEP_LEVEL", field: "fibDeepLevel", type: "num" },
  { suffix: "RANGE_MIN_PCT", field: "rangeMinPct", type: "num" },
  { suffix: "VOLATILITY_CAP", field: "volatilityCap", type: "num" },
  { suffix: "FLIP_PCT", field: "flipPct", type: "num" },
  { suffix: "FLIP_STEP", field: "flipStep", type: "num" },
  // Ping-pong (Supertrend / spike 15m, setelah flip pertama).
  { suffix: "FLIP_MODE", field: "flipMode", type: "enum", options: FLIP_MODES },
  { suffix: "PP_ST_ATR_PERIOD", field: "ppStAtrPeriod", type: "int" },
  { suffix: "PP_ST_MULTIPLIER", field: "ppStMultiplier", type: "num" },
  { suffix: "PP_SPIKE_ATR_MULT", field: "ppSpikeAtrMult", type: "num" },
  { suffix: "PP_SPIKE_LOOKBACK_BARS", field: "ppSpikeLookbackBars", type: "int" },
  { suffix: "PP_DIP_MIN_PCT", field: "ppDipMinPct", type: "num" },
  { suffix: "PP_MIN_BB_WIDTH_PCT", field: "ppMinBbWidthPct", type: "num" },
  { suffix: "PP_MAX_ADX", field: "ppMaxAdx", type: "num" },
  { suffix: "PP_MIN_VOL_RATIO", field: "ppMinVolRatio", type: "num" },
  // Size & exits.
  { suffix: "SIZE_SOL", field: "sizeSol", type: "num" },
  { suffix: "MAX_OPEN", field: "maxOpen", type: "int" },
  { suffix: "MAX_POSITIONS", field: "maxPositions", type: "int" },
  { suffix: "TP_PCT", field: "tpPct", type: "num" },
  { suffix: "SL_PCT", field: "slPct", type: "num" },
  { suffix: "TRAIL_START_PCT", field: "trailStartPct", type: "num" },
  { suffix: "TRAIL_DISTANCE_PCT", field: "trailDistancePct", type: "num" },
  { suffix: "OOR_ABOVE_MIN", field: "oorAboveMin", type: "num" },
  { suffix: "OOR_BELOW_MIN", field: "oorBelowMin", type: "num" },
  { suffix: "MIN_VOLUME_5M_USD", field: "minVolume5mUsd", type: "num" },
  { suffix: "LOW_VOLUME_BARS", field: "lowVolumeBars", type: "int" },
  { suffix: "MAX_HOLD_MIN", field: "maxHoldMin", type: "num" },
  { suffix: "DRAIN_EXIT", field: "drainExit", type: "bool" },
];

export const PROFILE_DEFAULTS = {
  bidask_flip: {
    name: "bidask_flip",
    on: true,
    minMcapUsd: 200000,
    maxMcapUsd: 5000000,
    minTokenAgeH: 2,
    maxTokenAgeH: 0,
    minHolders: 500,
    maxTop10Pct: 30,
    minFees30mUsd: 1,
    minBaseFeePct: 1,
    minFeeActiveTvl30mPct: 0.2,
    minBinStep: 80,
    jupShieldSafeguard: true,
    fibEntryLevel: 0.382,
    fibDeepLevel: 0.786,
    rangeMinPct: 30,
    volatilityCap: 10,
    flipPct: 65,
    flipStep: 10,
    flipMode: "pingpong",
    ppStAtrPeriod: 10,
    ppStMultiplier: 3,
    ppSpikeAtrMult: 2,
    ppSpikeLookbackBars: 4,
    ppDipMinPct: 5,
    ppMinBbWidthPct: 15,
    ppMaxAdx: 35,
    ppMinVolRatio: 0.5,
    sizeSol: 0.5,
    maxOpen: 2,
    maxPositions: 2,
    tpPct: 10,
    slPct: 15,
    trailStartPct: 0,
    trailDistancePct: 0,
    oorAboveMin: 10,
    oorBelowMin: 15,
    minVolume5mUsd: 1000,
    lowVolumeBars: 3,
    maxHoldMin: 1440,
    drainExit: true,
  },
};

function parseField(f, raw, def) {
  if (f.type === "bool") return bool(raw, def);
  if (f.type === "enum") {
    const v = String(raw ?? "").trim().toLowerCase();
    return f.options.includes(v) ? v : def;
  }
  const n = num(raw, def);
  return f.type === "int" ? Math.floor(n) : n;
}

// Pasangan min/max yang terbalik diurutkan ulang (0 = tanpa max, tidak diurutkan).
function orderPair(p, lo, hi) {
  if (p[hi] > 0 && p[lo] > p[hi]) [p[lo], p[hi]] = [p[hi], p[lo]];
}

export function buildProfile(env, name) {
  const prefix = PROFILE_PREFIX[name];
  const defaults = PROFILE_DEFAULTS[name];
  const p = { name };
  for (const f of PROFILE_FIELDS) p[f.field] = parseField(f, env[`${prefix}_${f.suffix}`], defaults[f.field]);
  orderPair(p, "minMcapUsd", "maxMcapUsd");
  orderPair(p, "minTokenAgeH", "maxTokenAgeH");
  if (p.fibEntryLevel > p.fibDeepLevel) [p.fibEntryLevel, p.fibDeepLevel] = [p.fibDeepLevel, p.fibEntryLevel];
  return p;
}

export function buildAutoEntry(e) {
  return {
    scanIntervalSec: num(e.AUTO_SCAN_INTERVAL_SEC, 300),
    candidatesPerScan: Math.floor(num(e.AUTO_CANDIDATES_PER_SCAN, 3)),
    requireAuthoritiesOff: bool(e.AUTO_REQUIRE_AUTHORITIES_OFF, true),
    maxNonRefundableSol: num(e.AUTO_MAX_NONREFUNDABLE_SOL, 0.02),
    cooldownMin: num(e.AUTO_COOLDOWN_MIN, 120),
    cooldownLossMin: num(e.AUTO_COOLDOWN_LOSS_MIN, 720),
    dailyLossLimitSol: num(e.AUTO_DAILY_LOSS_LIMIT_SOL, 0.5),
    dexpaprikaHistoryDays: num(e.DEXPAPRIKA_HISTORY_DAYS, 7),
    sim: {
      poolDepthFactor: num(e.SIM_POOL_DEPTH_FACTOR, 1),
      poolSpreadBins: num(e.SIM_POOL_SPREAD_BINS, 69),
      swapCostPct: num(e.SIM_SWAP_COST_PCT, 1),
      txCostSol: num(e.SIM_TX_COST_SOL, 0.0002),
    },
    profiles: Object.fromEntries(PROFILES.map((n) => [n, buildProfile(e, n)])),
  };
}

// Bentuk exit per trade; 0 = fitur mati. Evil Panda tidak dipakai strategi.
export function profileExit(p) {
  return {
    tp: { on: p.tpPct > 0, pct: p.tpPct },
    sl: { on: p.slPct > 0, pct: p.slPct },
    trail: { on: p.trailDistancePct > 0, startPct: p.trailStartPct, distancePct: p.trailDistancePct },
    panda: { on: false },
  };
}

// Auto flip per trade; null = mati. step 0 = sekali. Ping-pong: hanya flip pertama (tanpa step);
// flip berikutnya diatur runner ping-pong (exit/pingpong.js).
export function profileAutoFlip(p) {
  if (!(p.flipPct > 0)) return null;
  if (p.flipMode === "pingpong") return { pct: p.flipPct };
  return p.flipStep > 0 ? { pct: p.flipPct, step: p.flipStep } : { pct: p.flipPct };
}
