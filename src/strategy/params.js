// Parameter strategi Auto Entry (bid-ask flip): dua profil (degen, multihour) + global.
// Semua dibaca dari peta env (strat.conf) dengan prefix per profil.
import { bool, num } from "../config/env.js";

export const PROFILES = ["degen", "multihour"];
export const PROFILE_PREFIX = { degen: "DEGEN", multihour: "MULTI" };

const TIMING = ["pullback", "immediate"];
const RANGE_MODES = ["fixed", "support"];

// Urutan = tabel spec section 7 (juga urutan profileToConf).
export const PROFILE_FIELDS = [
  { suffix: "ON", field: "on", type: "bool" },
  { suffix: "SIZE_SOL", field: "sizeSol", type: "num" },
  { suffix: "MAX_OPEN", field: "maxOpen", type: "int" },
  { suffix: "MIN_TVL_USD", field: "minTvlUsd", type: "num" },
  { suffix: "MIN_VOLUME_30M_USD", field: "minVolume30mUsd", type: "num" },
  { suffix: "MIN_FEE_TVL_30M_PCT", field: "minFeeTvl30mPct", type: "num" },
  { suffix: "MIN_MCAP_USD", field: "minMcapUsd", type: "num" },
  { suffix: "MIN_HOLDERS", field: "minHolders", type: "int" },
  { suffix: "MAX_POOL_AGE_H", field: "maxPoolAgeH", type: "num" },
  { suffix: "MIN_BIN_STEP", field: "minBinStep", type: "int" },
  { suffix: "MAX_BASE_FEE_PCT", field: "maxBaseFeePct", type: "num" },
  { suffix: "VOLATILITY_MIN_PCT", field: "volatilityMinPct", type: "num" },
  { suffix: "VOLATILITY_MAX_PCT", field: "volatilityMaxPct", type: "num" },
  { suffix: "MIN_LPS", field: "minLps", type: "int" },
  { suffix: "ENTRY_TIMING", field: "entryTiming", type: "enum", options: TIMING },
  { suffix: "PUMP_LOOKBACK_MIN", field: "pumpLookbackMin", type: "num" },
  { suffix: "MIN_PUMP_PCT", field: "minPumpPct", type: "num" },
  { suffix: "MIN_PULLBACK_PCT", field: "minPullbackPct", type: "num" },
  { suffix: "MAX_PULLBACK_PCT", field: "maxPullbackPct", type: "num" },
  { suffix: "RANGE_MODE", field: "rangeMode", type: "enum", options: RANGE_MODES },
  { suffix: "RANGE_PCT", field: "rangePct", type: "num" },
  { suffix: "RANGE_MIN_PCT", field: "rangeMinPct", type: "num" },
  { suffix: "RANGE_MAX_PCT", field: "rangeMaxPct", type: "num" },
  { suffix: "SUPPORT_LOOKBACK_MIN", field: "supportLookbackMin", type: "num" },
  { suffix: "SUPPORT_BUFFER_PCT", field: "supportBufferPct", type: "num" },
  { suffix: "MAX_POSITIONS", field: "maxPositions", type: "int" },
  { suffix: "FLIP_PCT", field: "flipPct", type: "num" },
  { suffix: "TP_PCT", field: "tpPct", type: "num" },
  { suffix: "SL_PCT", field: "slPct", type: "num" },
  { suffix: "TRAIL_START_PCT", field: "trailStartPct", type: "num" },
  { suffix: "TRAIL_DISTANCE_PCT", field: "trailDistancePct", type: "num" },
  { suffix: "OOR_ABOVE_MIN", field: "oorAboveMin", type: "num" },
  { suffix: "OOR_BELOW_MIN", field: "oorBelowMin", type: "num" },
  { suffix: "MIN_VOLUME_5M_USD", field: "minVolume5mUsd", type: "num" },
  { suffix: "LOW_VOLUME_BARS", field: "lowVolumeBars", type: "int" },
  { suffix: "MAX_HOLD_MIN", field: "maxHoldMin", type: "num" },
];

export const PROFILE_DEFAULTS = {
  degen: {
    name: "degen",
    on: true,
    sizeSol: 0.5,
    maxOpen: 2,
    minTvlUsd: 2000,
    minVolume30mUsd: 10000,
    minFeeTvl30mPct: 0.2,
    minMcapUsd: 200000,
    minHolders: 800,
    maxPoolAgeH: 72,
    minBinStep: 80,
    maxBaseFeePct: 5,
    volatilityMinPct: 2,
    volatilityMaxPct: 4,
    minLps: 10,
    entryTiming: "pullback",
    pumpLookbackMin: 60,
    minPumpPct: 20,
    minPullbackPct: 5,
    maxPullbackPct: 30,
    rangeMode: "fixed",
    rangePct: 50,
    rangeMinPct: 20,
    rangeMaxPct: 65,
    supportLookbackMin: 360,
    supportBufferPct: 5,
    maxPositions: 2,
    flipPct: 60,
    tpPct: 10,
    slPct: 15,
    trailStartPct: 0,
    trailDistancePct: 0,
    oorAboveMin: 10,
    oorBelowMin: 15,
    minVolume5mUsd: 1000,
    lowVolumeBars: 3,
    maxHoldMin: 120,
  },
  multihour: {
    name: "multihour",
    on: true,
    sizeSol: 1,
    maxOpen: 2,
    minTvlUsd: 10000,
    minVolume30mUsd: 5000,
    minFeeTvl30mPct: 0.2,
    minMcapUsd: 3000000,
    minHolders: 2000,
    maxPoolAgeH: 0,
    minBinStep: 20,
    maxBaseFeePct: 2,
    volatilityMinPct: 2,
    volatilityMaxPct: 4,
    minLps: 20,
    entryTiming: "pullback",
    pumpLookbackMin: 240,
    minPumpPct: 10,
    minPullbackPct: 3,
    maxPullbackPct: 20,
    rangeMode: "support",
    rangePct: 35,
    rangeMinPct: 15,
    rangeMaxPct: 50,
    supportLookbackMin: 1440,
    supportBufferPct: 5,
    maxPositions: 2,
    flipPct: 60,
    tpPct: 5,
    slPct: 12,
    trailStartPct: 0,
    trailDistancePct: 0,
    oorAboveMin: 30,
    oorBelowMin: 60,
    minVolume5mUsd: 500,
    lowVolumeBars: 6,
    maxHoldMin: 1440,
  },
};

function parseField(f, raw, def) {
  if (f.type === "bool") return bool(raw, def);
  if (f.type === "enum") return f.options.includes(raw) ? raw : def;
  const n = num(raw, def);
  return f.type === "int" ? Math.floor(n) : n;
}

// Pasangan min/max yang terbalik diurutkan ulang.
function orderPair(p, lo, hi) {
  if (p[lo] > p[hi]) [p[lo], p[hi]] = [p[hi], p[lo]];
}

export function buildProfile(env, name) {
  const prefix = PROFILE_PREFIX[name];
  const defaults = PROFILE_DEFAULTS[name];
  const p = { name };
  for (const f of PROFILE_FIELDS) p[f.field] = parseField(f, env[`${prefix}_${f.suffix}`], defaults[f.field]);
  orderPair(p, "rangeMinPct", "rangeMaxPct");
  orderPair(p, "volatilityMinPct", "volatilityMaxPct");
  orderPair(p, "minPullbackPct", "maxPullbackPct");
  return p;
}

export function buildAutoEntry(e) {
  return {
    scanIntervalSec: num(e.AUTO_SCAN_INTERVAL_SEC, 60),
    candidatesPerScan: Math.floor(num(e.AUTO_CANDIDATES_PER_SCAN, 5)),
    organicScoreMin: num(e.AUTO_ORGANIC_SCORE_MIN, 60),
    topHoldersMaxPct: num(e.AUTO_TOP_HOLDERS_MAX_PCT, 30),
    requireAuthoritiesOff: bool(e.AUTO_REQUIRE_AUTHORITIES_OFF, true),
    maxNonRefundableSol: num(e.AUTO_MAX_NONREFUNDABLE_SOL, 0.02),
    cooldownMin: num(e.AUTO_COOLDOWN_MIN, 120),
    cooldownLossMin: num(e.AUTO_COOLDOWN_LOSS_MIN, 720),
    dailyLossLimitSol: num(e.AUTO_DAILY_LOSS_LIMIT_SOL, 0.5),
    sim: {
      poolDepthFactor: num(e.SIM_POOL_DEPTH_FACTOR, 1),
      poolSpreadBins: num(e.SIM_POOL_SPREAD_BINS, 69),
      swapCostPct: num(e.SIM_SWAP_COST_PCT, 1),
      txCostSol: num(e.SIM_TX_COST_SOL, 0.0002),
    },
    profiles: Object.fromEntries(PROFILES.map((n) => [n, buildProfile(e, n)])),
  };
}

// Bentuk exit per trade; 0 = fitur mati. Evil Panda tidak dipakai profil.
export function profileExit(p) {
  return {
    tp: { on: p.tpPct > 0, pct: p.tpPct },
    sl: { on: p.slPct > 0, pct: p.slPct },
    trail: { on: p.trailDistancePct > 0, startPct: p.trailStartPct, distancePct: p.trailDistancePct },
    panda: { on: false },
  };
}

// Baris strat.conf (KEY=value) untuk satu profil, urutan PROFILE_FIELDS.
export function profileToConf(p) {
  const prefix = PROFILE_PREFIX[p.name];
  return PROFILE_FIELDS.map((f) => `${prefix}_${f.suffix}=${p[f.field]}`).join("\n") + "\n";
}
