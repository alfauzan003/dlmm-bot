import test from "node:test";
import assert from "node:assert/strict";
import { WSOL_MINT } from "../src/core/constants.js";
import { pctToBinRange } from "../src/lp/range.js";
import { buildProfile, buildAutoEntry } from "../src/strategy/params.js";
import {
  poolQueryUrl,
  toPoolRow,
  passesPoolFilters,
  sortByFeeActiveTvl,
  pickPoolPerToken,
  coversMinRange,
  binsForPct,
  passesTokenFilters,
  volatilityQueryUrl,
  closedBars,
  toSolPerToken,
} from "../src/strategy/screen.js";

const HOUR = 3600000;
const NOW = 1000 * HOUR;
const P = buildProfile({}, "bidask_flip");

// Baris pool-discovery (timeframe 30m).
const raw = (o = {}) => ({
  pool_address: "P1",
  name: "AAA-SOL",
  token_x: {
    address: "MintA",
    market_cap: 500000,
    holders: 1000,
    top_holders_pct: 12,
    created_at: NOW - 10 * HOUR,
    price: 0.001,
    has_mint_authority: false,
    has_freeze_authority: false,
  },
  token_y: { address: WSOL_MINT },
  dlmm_params: { bin_step: 100 },
  fee_pct: 2,
  tvl: 30000,
  active_tvl: 25000,
  volume: 50000,
  fee: 900,
  fee_tvl_ratio: 3,
  fee_active_tvl_ratio: 3.6,
  volatility: 4.2,
  base_token_holders: 1001,
  pool_created_at: NOW - 5 * HOUR,
  ...o,
});

test("toPoolRow maps a pool-discovery SOL pair with base = X", () => {
  assert.deepEqual(toPoolRow(raw()), {
    address: "P1",
    name: "AAA-SOL",
    baseMint: "MintA",
    baseIsX: true,
    binStep: 100,
    baseFeePct: 2,
    protocolFeePct: 0,
    tvlUsd: 30000,
    activeTvlUsd: 25000,
    volume30mUsd: 50000,
    fees30mUsd: 900,
    feeTvl30mPct: 3,
    feeActiveTvl30mPct: 3.6,
    mcapUsd: 500000,
    holders: 1001,
    top10Pct: 12,
    tokenCreatedAt: NOW - 10 * HOUR,
    basePriceUsd: 0.001,
    authoritiesOff: true,
    criticalWarnings: [],
    createdAt: NOW - 5 * HOUR,
  });
});

test("toPoolRow: SOL as X takes base from Y", () => {
  const r = toPoolRow(raw({ token_x: { address: WSOL_MINT }, token_y: { address: "MintB", market_cap: 1, holders: 2 } }));
  assert.equal(r.baseMint, "MintB");
  assert.equal(r.baseIsX, false);
});

test("toPoolRow malformed rows are null; missing top10 stays null", () => {
  for (const o of [{ token_x: null }, { tvl: 0 }, { tvl: undefined }, { token_y: { address: "USDC" } }, { dlmm_params: null }])
    assert.equal(toPoolRow(raw(o)), null, JSON.stringify(o));
  const r = toPoolRow(raw({ token_x: { address: "MintA" } }));
  assert.equal(r.top10Pct, null);
  assert.equal("volatility" in r, false, "volatility comes from the separate 24h request");
});

test("volatilityQueryUrl: 24h, only the given pools", () => {
  const u = new URL(volatilityQueryUrl(["P1", "P2", "P3"]));
  assert.equal(u.origin + u.pathname, "https://pool-discovery-api.datapi.meteora.ag/pools");
  assert.equal(u.searchParams.get("timeframe"), "24h");
  assert.equal(u.searchParams.get("page_size"), "3");
  assert.equal(u.searchParams.get("filter_by"), "pool_address=[P1,P2,P3]");
});

test("poolQueryUrl: pool-discovery, timeframe 30m, every filter on the server", () => {
  const u = new URL(poolQueryUrl(P, NOW));
  assert.equal(u.origin + u.pathname, "https://pool-discovery-api.datapi.meteora.ag/pools");
  assert.equal(u.searchParams.get("timeframe"), "30m");
  assert.equal(u.searchParams.get("page_size"), "200");
  assert.equal(
    u.searchParams.get("filter_by"),
    [
      "pool_type=dlmm",
      "is_blacklisted=false",
      "base_token_market_cap>=200000",
      "base_token_holders>=500",
      "fee>=1",
      "fee_pct>=1",
      "fee_active_tvl_ratio>=0.2",
      "bin_step>=80",
      "base_token_has_critical_warnings=false",
      "quote_token_has_critical_warnings=false",
      "base_token_market_cap<=5000000",
      "base_token_top_holders_pct<=30",
      `base_token_created_at<=${NOW - 2 * HOUR}`,
    ].join(" && ")
  );
  const v = new URL(
    poolQueryUrl({ ...P, maxMcapUsd: 0, maxTop10Pct: 0, minTokenAgeH: 0, maxTokenAgeH: 48, jupShieldSafeguard: false }, NOW)
  );
  const f = v.searchParams.get("filter_by");
  assert.doesNotMatch(f, /market_cap<=|top_holders_pct|created_at<=|critical_warnings/);
  assert.match(f, new RegExp(`base_token_created_at>=${NOW - 48 * HOUR}`));
});

test("passesPoolFilters reasons", () => {
  const good = toPoolRow(raw());
  assert.deepEqual(passesPoolFilters(good, P, NOW), { ok: true, reason: null });
  const cases = [
    [{ mcapUsd: 199999 }, "mcap"],
    [{ mcapUsd: 5000001 }, "mcap"],
    [{ tokenCreatedAt: NOW - 1 * HOUR }, "age"],
    [{ tokenCreatedAt: 0 }, "age"],
    [{ holders: 499 }, "holders"],
    [{ top10Pct: 30.1 }, "top10"],
    [{ top10Pct: null }, "top10"],
    [{ fees30mUsd: 0.9 }, "fees"],
    [{ baseFeePct: 0.9 }, "base_fee"],
    [{ feeActiveTvl30mPct: 0.19 }, "fee_active_tvl"],
    [{ binStep: 79 }, "bin_step"],
    [{ criticalWarnings: ["TRANSFER_FEE_CONFIGURED"] }, "jupshield"],
  ];
  for (const [o, reason] of cases) assert.deepEqual(passesPoolFilters({ ...good, ...o }, P, NOW), { ok: false, reason }, reason);
  assert.equal(passesPoolFilters({ ...good, top10Pct: null }, { ...P, maxTop10Pct: 0 }, NOW).ok, true);
  assert.equal(passesPoolFilters({ ...good, tokenCreatedAt: NOW - 50 * HOUR }, { ...P, maxTokenAgeH: 48 }, NOW).reason, "age");
});

test("sortByFeeActiveTvl + pickPoolPerToken: top pool per token wins, next token fills in", () => {
  const row = toPoolRow(raw());
  const a1 = { ...row, address: "A1", feeActiveTvl30mPct: 5 };
  const a2 = { ...row, address: "A2", feeActiveTvl30mPct: 9 };
  const b = { ...row, address: "B", baseMint: "MintB", feeActiveTvl30mPct: 7 };
  const c = { ...row, address: "C", baseMint: "MintC", feeActiveTvl30mPct: 1 };
  const sorted = sortByFeeActiveTvl([a1, c, b, a2]);
  assert.deepEqual(sorted.map((r) => r.address), ["A2", "B", "A1", "C"]);
  assert.deepEqual(pickPoolPerToken(sorted).map((r) => r.address), ["A2", "B", "C"]);
});

test("binsForPct matches pctToBinRange", () => {
  assert.equal(binsForPct(20, 1), 2231);
  assert.equal(binsForPct(20, 100), 22);
  for (const [pct, s] of [[20, 1], [20, 100], [65, 80]]) {
    const r = pctToBinRange({ activeBin: 0, binStep: s, below: pct, above: 0, baseIsX: true });
    assert.equal(binsForPct(pct, s) + 1, r.binCount);
  }
});

test("coversMinRange", () => {
  assert.equal(coversMinRange(100, { rangeMinPct: 20, maxPositions: 2 }), true);
  assert.equal(coversMinRange(1, { rangeMinPct: 20, maxPositions: 1 }), false); // 2232 bins
});

test("passesTokenFilters re-checks Jupiter mcap, holders, top 10, age and authorities", () => {
  const g = buildAutoEntry({});
  const ok = {
    mcap: 500000,
    holderCount: 1000,
    createdAt: new Date(NOW - 10 * HOUR).toISOString(),
    audit: { topHoldersPercentage: 20, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
  };
  assert.equal(passesTokenFilters(ok, P, g, NOW).ok, true);
  assert.equal(passesTokenFilters(null, P, g, NOW).reason, "no_token");
  assert.equal(passesTokenFilters({ ...ok, mcap: 6_000_000 }, P, g, NOW).reason, "mcap");
  assert.equal(passesTokenFilters({ ...ok, holderCount: 10 }, P, g, NOW).reason, "holders");
  assert.equal(passesTokenFilters({ ...ok, audit: { ...ok.audit, topHoldersPercentage: 31 } }, P, g, NOW).reason, "top10");
  assert.equal(passesTokenFilters({ ...ok, createdAt: new Date(NOW - HOUR).toISOString() }, P, g, NOW).reason, "age");
  const withAuthority = { ...ok, audit: { ...ok.audit, freezeAuthorityDisabled: false } };
  assert.equal(passesTokenFilters(withAuthority, P, g, NOW).reason, "authorities");
  assert.equal(passesTokenFilters(withAuthority, P, { ...g, requireAuthoritiesOff: false }, NOW).ok, true);
  // Field Jupiter yang hilang (mcap / holders / createdAt) tidak menggagalkan: sudah dicek dari pool-discovery.
  assert.equal(passesTokenFilters({ audit: ok.audit }, P, g, NOW).ok, true);
});

test("closedBars drops the forming bar", () => {
  const bars = Array.from({ length: 7 }, (_, i) => ({ time: i * 300, open: 1, high: 1.04, low: 1.0, close: 1, volume: 1 }));
  assert.equal(closedBars(bars, 7 * 300 * 1000 - 1).length, 6);
});

test("toSolPerToken inverts SOL-as-X bars (high/low swap), keeps volume, identity for token-as-X", () => {
  const bars = [{ time: 0, open: 2, high: 4, low: 1, close: 2.5, volume: 7 }];
  assert.deepEqual(toSolPerToken(bars, true), bars);
  assert.deepEqual(toSolPerToken(bars, false), [{ time: 0, open: 0.5, high: 1, low: 0.25, close: 0.4, volume: 7 }]);
});

test("toSolPerToken drops bars with non-positive or non-finite prices", () => {
  const ok = { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 };
  const bad = [{ ...ok, time: 300, open: 0 }, { ...ok, time: 600, close: NaN }, { ...ok, time: 900, low: -1 }, { ...ok, time: 1200, high: Infinity }];
  assert.deepEqual(toSolPerToken([ok, ...bad], false).map((b) => b.time), [0]);
  assert.deepEqual(toSolPerToken([ok, ...bad], true).map((b) => b.time), [0]);
});

test("toSolPerToken fails closed when baseIsX is not a boolean", () => {
  const bars = [{ time: 0, open: 2, high: 4, low: 1, close: 2.5, volume: 7 }];
  for (const v of [undefined, null, 0, "true"]) assert.deepEqual(toSolPerToken(bars, v), [], String(v));
});

test("toPoolRow keeps only critical JupShield warnings; safeguard off lets them pass", () => {
  const warnings = [
    { type: "TRANSFER_FEE_CONFIGURED", severity: "critical" },
    { type: "NOT_VERIFIED", severity: "info" },
    { type: "HAS_FREEZE_AUTHORITY", severity: "warning" },
  ];
  const r = toPoolRow(raw({ token_x: { ...raw().token_x, warnings } }));
  assert.deepEqual(r.criticalWarnings, ["TRANSFER_FEE_CONFIGURED"]);
  assert.equal(passesPoolFilters(r, P, NOW).reason, "jupshield");
  assert.equal(passesPoolFilters(r, { ...P, jupShieldSafeguard: false }, NOW).ok, true);
});
