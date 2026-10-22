// Filter screener Auto Entry (murni, tanpa I/O): query pool Meteora, filter pool/token, volatilitas.
import { WSOL_MINT } from "../core/constants.js";

const DATAPI_POOLS = "https://dlmm.datapi.meteora.ag/pools";
const HOUR_MS = 3600000;
export const BIN_PER_POSITION = 70; // sama dengan DEFAULT_BIN_PER_POSITION

// Jumlah bin di bawah bin aktif untuk range -pct% (binsBelow di pctToBinRange, lp/range.js); total bin = hasil + 1.
export function binsForPct(pct, binStep) {
  return Math.floor(Math.log(1 - pct / 100) / -Math.log(1 + binStep / 10000));
}

export function poolQueryUrl(p, now, { pageSize = 100 } = {}) {
  const parts = [
    `tvl>${p.minTvlUsd}`,
    `volume_30m>${p.minVolume30mUsd}`,
    `fee_tvl_ratio_30m>${p.minFeeTvl30mPct}`,
    `bin_step>=${p.minBinStep}`,
    "is_blacklisted=false",
  ];
  if (p.maxPoolAgeH > 0) parts.push(`pool_created_at>${now - p.maxPoolAgeH * HOUR_MS}`);
  return `${DATAPI_POOLS}?page_size=${pageSize}&sort_by=fee_tvl_ratio_30m:desc&filter_by=${encodeURIComponent(parts.join(" && "))}`;
}

// Respons datapi -> baris pool. Hanya pair SOL; null bila data inti hilang.
export function toPoolRow(raw) {
  const x = raw?.token_x;
  const y = raw?.token_y;
  const cfg = raw?.pool_config;
  if (!x || !y || !cfg) return null;
  let base;
  let baseIsX;
  if (y.address === WSOL_MINT && x.address && x.address !== WSOL_MINT) [base, baseIsX] = [x, true];
  else if (x.address === WSOL_MINT && y.address && y.address !== WSOL_MINT) [base, baseIsX] = [y, false];
  else return null;
  const binStep = Number(cfg.bin_step);
  const tvlUsd = Number(raw.tvl);
  if (!raw.address || !(binStep > 0) || !(tvlUsd > 0)) return null;
  return {
    address: raw.address,
    name: raw.name ?? "",
    baseMint: base.address,
    baseIsX,
    binStep,
    baseFeePct: Number(cfg.base_fee_pct) || 0,
    protocolFeePct: Number(cfg.protocol_fee_pct) || 0,
    tvlUsd,
    volume30mUsd: Number(raw.volume?.["30m"]) || 0,
    feeTvl30mPct: Number(raw.fee_tvl_ratio?.["30m"]) || 0,
    mcapUsd: Number(base.market_cap) || 0,
    holders: Number(base.holders) || 0,
    createdAt: Number(raw.created_at) || 0,
  };
}

export function passesPoolFilters(row, p, now) {
  const fail = (reason) => ({ ok: false, reason });
  if (row.tvlUsd < p.minTvlUsd) return fail("tvl");
  if (row.volume30mUsd < p.minVolume30mUsd) return fail("volume");
  if (row.feeTvl30mPct < p.minFeeTvl30mPct) return fail("fee_tvl");
  if (row.mcapUsd < p.minMcapUsd) return fail("mcap");
  if (row.holders < p.minHolders) return fail("holders");
  if (p.maxPoolAgeH > 0 && now - row.createdAt > p.maxPoolAgeH * HOUR_MS) return fail("age");
  if (row.binStep < p.minBinStep) return fail("bin_step");
  if (row.baseFeePct > p.maxBaseFeePct) return fail("base_fee");
  return { ok: true, reason: null };
}

// Satu pool per token: base fee terendah, lalu TVL tertinggi, lalu bin step terkecil.
export function pickPoolPerToken(rows) {
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.baseMint);
    if (!cur || better(r, cur)) best.set(r.baseMint, r);
  }
  return [...best.values()];
}

function better(a, b) {
  if (a.baseFeePct !== b.baseFeePct) return a.baseFeePct < b.baseFeePct;
  if (a.tvlUsd !== b.tvlUsd) return a.tvlUsd > b.tvlUsd;
  return a.binStep < b.binStep;
}

// Range minimum harus muat di maxPositions posisi (70 bin per posisi).
export function coversMinRange(binStep, p) {
  return binsForPct(p.rangeMinPct, binStep) + 1 <= p.maxPositions * BIN_PER_POSITION;
}

export function passesTokenFilters(token, g) {
  const fail = (reason) => ({ ok: false, reason });
  if (!token) return fail("no_token");
  if (!(token.organicScore >= g.organicScoreMin)) return fail("organic");
  const audit = token.audit ?? {};
  if (!(audit.topHoldersPercentage <= g.topHoldersMaxPct)) return fail("top_holders");
  if (g.requireAuthoritiesOff && !(audit.mintAuthorityDisabled === true && audit.freezeAuthorityDisabled === true))
    return fail("authorities");
  return { ok: true, reason: null };
}

// Buang bar yang masih terbentuk (time dalam detik).
export function closedBars(candles, nowMs, barSec = 300) {
  return candles.filter((c) => (c.time + barSec) * 1000 <= nowMs);
}

// OHLCV pool Meteora = token Y per token X. SOL sebagai Y (baseIsX) sudah SOL per token; SOL sebagai X dibalik
// (high/low bertukar). Bar dengan harga <= 0 / tidak finite dibuang.
export function toSolPerToken(bars, baseIsX) {
  const valid = (b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0);
  const kept = bars.filter(valid);
  if (baseIsX) return kept;
  return kept.map((b) => ({ time: b.time, open: 1 / b.open, high: 1 / b.low, low: 1 / b.high, close: 1 / b.close, volume: b.volume }));
}

// Rata-rata (high-low)/open*100 dari n bar terakhir; null bila bar kurang.
export function volatilityPct(bars, n = 6) {
  if (bars.length < n) return null;
  const last = bars.slice(-n);
  if (last.some((b) => !(b.open > 0))) return null;
  return last.reduce((s, b) => s + ((b.high - b.low) / b.open) * 100, 0) / n;
}

export function passesVolatility(vol, p) {
  return vol != null && vol >= p.volatilityMinPct && vol <= p.volatilityMaxPct;
}
