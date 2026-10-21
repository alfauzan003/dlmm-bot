import test from "node:test";
import assert from "node:assert/strict";
import { WSOL_MINT } from "../src/core/constants.js";
import { buildProfile, buildAutoEntry } from "../src/strategy/params.js";
import {
  poolQueryUrl,
  toPoolRow,
  passesPoolFilters,
  pickPoolPerToken,
  coversMinRange,
  binsForPct,
  passesTokenFilters,
  closedBars,
  volatilityPct,
  passesVolatility,
} from "../src/strategy/screen.js";

const raw = (o = {}) => ({
  address: "P1",
  name: "AAA-SOL",
  token_x: { address: "MintA", market_cap: 500000, holders: 1000 },
  token_y: { address: WSOL_MINT },
  pool_config: { bin_step: 100, base_fee_pct: 2, protocol_fee_pct: 10 },
  tvl: 30000,
  volume: { "30m": 50000 },
  fee_tvl_ratio: { "30m": 4.6 },
  created_at: 1_000_000,
  ...o,
});

test("toPoolRow maps a SOL pair with base = X", () => {
  assert.deepEqual(toPoolRow(raw()), {
    address: "P1",
    name: "AAA-SOL",
    baseMint: "MintA",
    baseIsX: true,
    binStep: 100,
    baseFeePct: 2,
    protocolFeePct: 10,
    tvlUsd: 30000,
    volume30mUsd: 50000,
    feeTvl30mPct: 4.6,
    mcapUsd: 500000,
    holders: 1000,
    createdAt: 1_000_000,
  });
});

test("toPoolRow: SOL as X takes base from Y", () => {
  const r = toPoolRow(raw({ token_x: { address: WSOL_MINT }, token_y: { address: "MintB", market_cap: 1, holders: 2 } }));
  assert.equal(r.baseMint, "MintB");
  assert.equal(r.baseIsX, false);
});

test("toPoolRow malformed rows are null", () => {
  for (const o of [{ token_x: null }, { tvl: 0 }, { tvl: undefined }, { token_y: { address: "USDC" } }, { pool_config: null }])
    assert.equal(toPoolRow(raw(o)), null, JSON.stringify(o));
  assert.equal(toPoolRow(raw({ token_x: { address: "MintA", market_cap: null, holders: null } })).mcapUsd, 0);
});

test("poolQueryUrl includes age filter only when maxPoolAgeH > 0", () => {
  const u = decodeURIComponent(poolQueryUrl({ ...buildProfile({}, "degen") }, 100 * 3600000));
  assert.match(u, /pool_created_at>100800000/); // 100h - 72h
  assert.match(u, /page_size=100&sort_by=fee_tvl_ratio_30m:desc&filter_by=/);
  assert.match(u, /tvl>2000 && volume_30m>10000 && fee_tvl_ratio_30m>0\.2 && bin_step>=80 && is_blacklisted=false/);
  assert.doesNotMatch(decodeURIComponent(poolQueryUrl(buildProfile({}, "multihour"), 0)), /pool_created_at/);
});

test("passesPoolFilters reasons", () => {
  const p = buildProfile({}, "degen"); // tvl 2000, vol 10000, fee/tvl 0.2, mcap 200000, holders 800, age 72h, bin 80, fee 5
  const now = 100 * 3600000;
  const good = { ...toPoolRow(raw()), createdAt: now - 10 * 3600000 };
  assert.deepEqual(passesPoolFilters(good, p, now), { ok: true, reason: null });
  const cases = [
    [{ tvlUsd: 1999 }, "tvl"],
    [{ volume30mUsd: 9999 }, "volume"],
    [{ feeTvl30mPct: 0.1 }, "fee_tvl"],
    [{ mcapUsd: 199999 }, "mcap"],
    [{ holders: 799 }, "holders"],
    [{ createdAt: now - 73 * 3600000 }, "age"],
    [{ binStep: 79 }, "bin_step"],
    [{ baseFeePct: 5.1 }, "base_fee"],
  ];
  for (const [o, reason] of cases) assert.deepEqual(passesPoolFilters({ ...good, ...o }, p, now), { ok: false, reason }, reason);
  // maxPoolAgeH = 0 -> tidak ada batas umur
  assert.equal(passesPoolFilters({ ...good, createdAt: 0 }, { ...p, maxPoolAgeH: 0 }, now).ok, true);
});

test("pickPoolPerToken: lowest base fee, then highest TVL, then smallest bin step", () => {
  const a = { ...toPoolRow(raw()), address: "A", baseFeePct: 2, tvlUsd: 10 };
  const b = { ...a, address: "B", baseFeePct: 1, tvlUsd: 5 };
  const c = { ...a, address: "C", baseFeePct: 1, tvlUsd: 5, binStep: 80 };
  assert.deepEqual(pickPoolPerToken([a, b, c]).map((r) => r.address), ["C"]);
  const d = { ...a, address: "D", baseFeePct: 1, tvlUsd: 9 };
  assert.deepEqual(pickPoolPerToken([a, b, d]).map((r) => r.address), ["D"]);
  const other = { ...a, address: "E", baseMint: "MintZ" };
  assert.deepEqual(pickPoolPerToken([a, other]).map((r) => r.address), ["A", "E"]);
});

test("binsForPct matches pctToBinRange", () => {
  assert.equal(binsForPct(20, 1), 2232);
  assert.equal(binsForPct(20, 100), 23);
});

test("coversMinRange", () => {
  assert.equal(coversMinRange(100, { rangeMinPct: 20, maxPositions: 2 }), true);
  assert.equal(coversMinRange(1, { rangeMinPct: 20, maxPositions: 1 }), false); // 2232 bins
});

test("passesTokenFilters", () => {
  const g = buildAutoEntry({});
  const ok = { organicScore: 70, audit: { topHoldersPercentage: 20, mintAuthorityDisabled: true, freezeAuthorityDisabled: true } };
  assert.equal(passesTokenFilters(ok, g).ok, true);
  assert.equal(passesTokenFilters(null, g).reason, "no_token");
  assert.equal(passesTokenFilters({ ...ok, organicScore: 59 }, g).reason, "organic");
  assert.equal(passesTokenFilters({ ...ok, audit: { ...ok.audit, topHoldersPercentage: 31 } }, g).reason, "top_holders");
  assert.equal(passesTokenFilters({ ...ok, audit: { ...ok.audit, freezeAuthorityDisabled: false } }, g).reason, "authorities");
  assert.equal(passesTokenFilters({ ...ok, audit: { ...ok.audit, freezeAuthorityDisabled: false } }, { ...g, requireAuthoritiesOff: false }).ok, true);
});

test("closedBars drops the forming bar; volatility needs 6 bars", () => {
  const bars = Array.from({ length: 7 }, (_, i) => ({ time: i * 300, open: 1, high: 1.04, low: 1.0, close: 1, volume: 1 }));
  assert.equal(closedBars(bars, 7 * 300 * 1000 - 1).length, 6);
  assert.ok(Math.abs(volatilityPct(bars.slice(0, 6)) - 4) < 1e-9);
  assert.equal(volatilityPct(bars.slice(0, 5)), null);
  assert.equal(passesVolatility(null, { volatilityMinPct: 0, volatilityMaxPct: 100 }), false);
  assert.equal(passesVolatility(4, { volatilityMinPct: 2, volatilityMaxPct: 4 }), true);
  assert.equal(passesVolatility(4.1, { volatilityMinPct: 2, volatilityMaxPct: 4 }), false);
});
