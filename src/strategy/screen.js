// Filter screener Auto Entry (murni, tanpa I/O): query pool-discovery Meteora, filter pool/token.
import { WSOL_MINT } from "../core/constants.js";

const DISCOVERY_POOLS = "https://pool-discovery-api.datapi.meteora.ag/pools";
const HOUR_MS = 3600000;
export const BIN_PER_POSITION = 70; // sama dengan DEFAULT_BIN_PER_POSITION

// Jumlah bin di bawah bin aktif untuk range -pct% (binsBelow di pctToBinRange, lp/range.js); total bin = hasil + 1.
export function binsForPct(pct, binStep) {
  return Math.floor(Math.log(1 - pct / 100) / -Math.log(1 + binStep / 10000));
}

// Query pool-discovery (timeframe 30m), semua filter strategi di server. sort_by API ini diabaikan server,
// jadi urutan fee / active TVL dibuat di klien (sortByFeeActiveTvl).
export function poolQueryUrl(p, now, { pageSize = 200 } = {}) {
  const parts = [
    "pool_type=dlmm",
    "is_blacklisted=false",
    `base_token_market_cap>=${p.minMcapUsd}`,
    `base_token_holders>=${p.minHolders}`,
    `fee>=${p.minFees30mUsd}`,
    `fee_pct>=${p.minBaseFeePct}`,
    `fee_active_tvl_ratio>=${p.minFeeActiveTvl30mPct}`,
    `bin_step>=${p.minBinStep}`,
  ];
  if (p.maxMcapUsd > 0) parts.push(`base_token_market_cap<=${p.maxMcapUsd}`);
  if (p.maxTop10Pct > 0) parts.push(`base_token_top_holders_pct<=${p.maxTop10Pct}`);
  if (p.minTokenAgeH > 0) parts.push(`base_token_created_at<=${Math.floor(now - p.minTokenAgeH * HOUR_MS)}`);
  if (p.maxTokenAgeH > 0) parts.push(`base_token_created_at>=${Math.floor(now - p.maxTokenAgeH * HOUR_MS)}`);
  const q = new URLSearchParams({
    page_size: String(pageSize),
    timeframe: "30m",
    filter_by: parts.join(" && "),
  });
  return `${DISCOVERY_POOLS}?${q}`;
}

// Volatility untuk rumus range diambil dari timeframe ini (request terpisah, hanya kandidat teratas).
export const VOLATILITY_TIMEFRAME = "24h";

export function volatilityQueryUrl(addresses) {
  const q = new URLSearchParams({
    page_size: String(Math.max(1, addresses.length)),
    timeframe: VOLATILITY_TIMEFRAME,
    filter_by: `pool_address=[${addresses.join(",")}]`,
  });
  return `${DISCOVERY_POOLS}?${q}`;
}

const n = (v) => (v == null ? NaN : Number(v)); // null jangan jadi 0

// Respons pool-discovery -> baris pool. Hanya pair SOL; null bila data inti hilang.
export function toPoolRow(raw) {
  const x = raw?.token_x;
  const y = raw?.token_y;
  if (!x || !y) return null;
  let base;
  let baseIsX;
  if (y.address === WSOL_MINT && x.address && x.address !== WSOL_MINT) [base, baseIsX] = [x, true];
  else if (x.address === WSOL_MINT && y.address && y.address !== WSOL_MINT) [base, baseIsX] = [y, false];
  else return null;
  const address = raw.pool_address ?? raw.address;
  const binStep = n(raw.dlmm_params?.bin_step);
  const tvlUsd = n(raw.tvl);
  if (!address || !(binStep > 0) || !(tvlUsd > 0)) return null;
  return {
    address,
    name: raw.name ?? "",
    baseMint: base.address,
    baseIsX,
    binStep,
    baseFeePct: n(raw.fee_pct) || 0,
    protocolFeePct: 0, // tidak ada di pool-discovery
    tvlUsd,
    activeTvlUsd: n(raw.active_tvl) || 0,
    volume30mUsd: n(raw.volume) || 0,
    fees30mUsd: n(raw.fee) || 0,
    feeTvl30mPct: n(raw.fee_tvl_ratio) || 0,
    feeActiveTvl30mPct: n(raw.fee_active_tvl_ratio) || 0,
    mcapUsd: n(base.market_cap) || 0,
    holders: n(raw.base_token_holders ?? base.holders) || 0,
    top10Pct: Number.isFinite(n(base.top_holders_pct)) ? n(base.top_holders_pct) : null,
    tokenCreatedAt: n(base.created_at) || 0,
    basePriceUsd: n(base.price) || null,
    authoritiesOff: base.has_mint_authority === false && base.has_freeze_authority === false,
    createdAt: n(raw.pool_created_at) || 0,
  };
}

// Cek ulang filter server di klien (data API bisa telat / filter diabaikan).
export function passesPoolFilters(row, p, now) {
  const fail = (reason) => ({ ok: false, reason });
  if (row.mcapUsd < p.minMcapUsd || (p.maxMcapUsd > 0 && row.mcapUsd > p.maxMcapUsd)) return fail("mcap");
  const ageH = row.tokenCreatedAt > 0 ? (now - row.tokenCreatedAt) / HOUR_MS : null;
  if (ageH == null || ageH < p.minTokenAgeH || (p.maxTokenAgeH > 0 && ageH > p.maxTokenAgeH)) return fail("age");
  if (row.holders < p.minHolders) return fail("holders");
  if (p.maxTop10Pct > 0 && !(Number.isFinite(row.top10Pct) && row.top10Pct <= p.maxTop10Pct)) return fail("top10");
  if (row.fees30mUsd < p.minFees30mUsd) return fail("fees");
  if (row.baseFeePct < p.minBaseFeePct) return fail("base_fee");
  if (row.feeActiveTvl30mPct < p.minFeeActiveTvl30mPct) return fail("fee_active_tvl");
  if (row.binStep < p.minBinStep) return fail("bin_step");
  return { ok: true, reason: null };
}

// Fee / active TVL 30m terbesar dulu (stabil untuk nilai sama).
export function sortByFeeActiveTvl(rows) {
  return rows
    .map((r, i) => [r, i])
    .sort((a, b) => b[0].feeActiveTvl30mPct - a[0].feeActiveTvl30mPct || a[1] - b[1])
    .map(([r]) => r);
}

// Satu pool per token: yang paling atas (urutan fee / active TVL) menang.
export function pickPoolPerToken(rows) {
  const seen = new Set();
  return rows.filter((r) => !seen.has(r.baseMint) && seen.add(r.baseMint));
}

// Range minimum harus muat di maxPositions posisi (70 bin per posisi).
export function coversMinRange(binStep, p) {
  return binsForPct(p.rangeMinPct, binStep) + 1 <= p.maxPositions * BIN_PER_POSITION;
}

// Info token Jupiter: cek ulang mcap, holders, top 10, umur, authority.
export function passesTokenFilters(token, p, g, now) {
  const fail = (reason) => ({ ok: false, reason });
  if (!token) return fail("no_token");
  const mcap = Number(token.mcap);
  if (Number.isFinite(mcap) && (mcap < p.minMcapUsd || (p.maxMcapUsd > 0 && mcap > p.maxMcapUsd))) return fail("mcap");
  const holders = Number(token.holderCount);
  if (Number.isFinite(holders) && holders < p.minHolders) return fail("holders");
  const audit = token.audit ?? {};
  const top10 = audit.topHoldersPercentage;
  if (p.maxTop10Pct > 0 && !(Number.isFinite(top10) && top10 <= p.maxTop10Pct)) return fail("top10");
  const created = Date.parse(token.createdAt ?? token.firstPool?.createdAt ?? "");
  if (Number.isFinite(created)) {
    const ageH = (now - created) / HOUR_MS;
    if (ageH < p.minTokenAgeH || (p.maxTokenAgeH > 0 && ageH > p.maxTokenAgeH)) return fail("age");
  }
  if (g.requireAuthoritiesOff && !(audit.mintAuthorityDisabled === true && audit.freezeAuthorityDisabled === true))
    return fail("authorities");
  return { ok: true, reason: null };
}

// Buang bar yang masih terbentuk (time dalam detik).
export function closedBars(candles, nowMs, barSec = 300) {
  return candles.filter((c) => (c.time + barSec) * 1000 <= nowMs);
}

// OHLCV pool Meteora = token Y per token X. SOL sebagai Y (baseIsX) sudah SOL per token; SOL sebagai X dibalik
// (high/low bertukar). Bar dengan harga <= 0 / tidak finite dibuang. baseIsX bukan boolean -> [] (fail closed).
export function toSolPerToken(bars, baseIsX) {
  if (typeof baseIsX !== "boolean") return [];
  const valid = (b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0);
  const kept = bars.filter(valid);
  if (baseIsX) return kept;
  return kept.map((b) => ({ time: b.time, open: 1 / b.open, high: 1 / b.low, low: 1 / b.high, close: 1 / b.close, volume: b.volume }));
}
