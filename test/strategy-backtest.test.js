import test from "node:test";
import assert from "node:assert/strict";
import { historicalScreen, replayPool, portfolioPass, SEARCH_SPACE, mulberry32, sampleParams, scoreTrades, optimize } from "../src/strategy/backtest.js";
import { buildAutoEntry, buildProfile } from "../src/strategy/params.js";

const g = buildAutoEntry({});
const profile = {
  ...buildProfile({}, "degen"),
  minTvlUsd: 0,
  minVolume30mUsd: 0,
  minFeeTvl30mPct: 0,
  minMcapUsd: 0,
  minHolders: 0,
  maxPoolAgeH: 0,
  minBinStep: 1,
  maxBaseFeePct: 100,
  volatilityMinPct: 0,
  volatilityMaxPct: 100,
  entryTiming: "pullback",
  pumpLookbackMin: 30,
  minPumpPct: 10,
  minPullbackPct: 2,
  maxPullbackPct: 30,
  rangeMode: "fixed",
  rangePct: 30,
  rangeMinPct: 10,
  rangeMaxPct: 50,
  maxPositions: 2,
  flipPct: 60,
  tpPct: 0,
  slPct: 0,
  oorAboveMin: 10,
  oorBelowMin: 15,
  lowVolumeBars: 0,
  maxHoldMin: 0,
  sizeSol: 1,
};
const rowFixture = {
  address: "POOL",
  name: "TOK-SOL",
  baseMint: "MINT",
  baseIsX: true,
  binStep: 100,
  baseFeePct: 2,
  protocolFeePct: 10,
  tvlUsd: 10000,
  volume30mUsd: 0,
  feeTvl30mPct: 0,
  mcapUsd: 1e6,
  holders: 5000,
  createdAt: 0,
};
const goodToken = { organicScore: 90, audit: { topHoldersPercentage: 10, mintAuthorityDisabled: true, freezeAuthorityDisabled: true } };
const flat = (t, px, v = 0) => ({ time: t, open: px, high: px, low: px, close: px, volume: v });

// Pump (+30% di 5 bar), lalu bar merah pullback -> sinyal, lalu 6 bar rata di 0.5 (range_broken) dan 7 bar rata di 1.
function cycle(t0) {
  const bars = [];
  let t = t0;
  for (let k = 0; k < 7; k++) bars.push(flat((t += 300), 1));
  bars.push({ time: (t += 300), open: 1, high: 1.3, low: 1, close: 1.3, volume: 100 });
  bars.push({ time: (t += 300), open: 1.3, high: 1.3, low: 1.2, close: 1.2, volume: 100 }); // pullback ~7.7%, merah
  for (let k = 0; k < 6; k++) bars.push(flat((t += 300), 0.5));
  return bars;
}
const twoCycles = () => {
  const a = cycle(0);
  return [...a, ...cycle(a[a.length - 1].time)];
};
const solUsdAt = () => 100;

test("historicalScreen computes 30m volume and fee/TVL from bars", () => {
  const row = { ...rowFixture, tvlUsd: 10000, baseFeePct: 2, mcapUsd: 1e6, createdAt: 0 };
  const bars = Array.from({ length: 6 }, (_, i) => ({ time: i * 300, open: 1, high: 1.03, low: 1, close: 1, volume: 1000 }));
  const r = historicalScreen(row, bars, 5, profile);
  assert.equal(r.ok, true);
  assert.equal(r.metrics.volume30mUsd, 6000);
  assert.ok(Math.abs(r.metrics.feeTvl30mPct - 1.2) < 1e-9);
  assert.ok(Math.abs(r.metrics.volatilityPct - 3) < 1e-9);
  assert.equal(r.metrics.mcapUsd, 1e6);
});

test("historicalScreen scales mcap by price and fails on thresholds", () => {
  const bars = Array.from({ length: 8 }, (_, i) => ({ time: i * 300, open: 1, high: 1, low: 1, close: i < 6 ? 1 : 2, volume: 1000 }));
  const r = historicalScreen({ ...rowFixture, mcapUsd: 1e6 }, bars, 5, { ...profile, volatilityMinPct: 1 });
  assert.equal(r.metrics.mcapUsd, 5e5);
  assert.equal(r.ok, false); // volatilitas 0 < 1
});

test("replayPool returns [] when token filters fail", () => {
  const bars = twoCycles();
  const bad = { ...goodToken, organicScore: 10 };
  assert.deepEqual(replayPool({ row: rowFixture, token: bad, bars, p: profile, g, solUsdAt }), []);
  assert.ok(replayPool({ row: rowFixture, token: goodToken, bars, p: profile, g, solUsdAt }).length > 0);
});

test("replayPool returns [] when the min range does not fit", () => {
  const row = { ...rowFixture, binStep: 1 };
  assert.deepEqual(replayPool({ row, token: goodToken, bars: twoCycles(), p: profile, g, solUsdAt }), []);
});

test("replayPool does not overlap trades and respects cooldown", () => {
  const bars = twoCycles();
  const args = { row: rowFixture, token: goodToken, bars, p: profile, solUsdAt };
  const one = replayPool({ ...args, g: { ...g, cooldownMin: 100000, cooldownLossMin: 100000 } });
  assert.equal(one.length, 1);
  assert.equal(one[0].pool, "POOL");
  assert.equal(one[0].mint, "MINT");
  assert.equal(one[0].profile, "degen");
  assert.ok(one[0].entryMetrics.pumpPct > 10 && one[0].entryMetrics.volume30mUsd >= 0);

  const two = replayPool({ ...args, g: { ...g, cooldownMin: 0, cooldownLossMin: 0 } });
  assert.ok(two.length >= 2);
  for (let k = 1; k < two.length; k++) assert.ok(two[k].entryTime > two[k - 1].exitTime);
});

test("portfolioPass enforces maxOpen and the daily brake", () => {
  const t = (entry, exit, pnlSol) => ({ entryTime: entry, exitTime: exit, pnlSol, pnlPct: pnlSol * 100, holdMin: 5, flipped: false, exitReason: "sl" });
  const { accepted } = portfolioPass(
    [t(0, 100, -0.3), t(10, 50, -0.3), t(200, 300, -0.3), t(400, 500, 1)],
    { ...profile, maxOpen: 1 },
    { ...g, dailyLossLimitSol: 0.5 }
  );
  assert.equal(accepted.length, 2); // ke-2 overlap, ke-4 setelah rem (-0.6)
  assert.deepEqual(accepted.map((x) => x.entryTime), [0, 200]);
});

test("portfolioPass resets the brake on the next WIB day", () => {
  const DAY = 86400000;
  const t = (entry, pnlSol) => ({ entryTime: entry, exitTime: entry + 1000, pnlSol, pnlPct: pnlSol * 100, holdMin: 1, flipped: false, exitReason: "sl" });
  const base = Date.UTC(2026, 0, 10, 0, 0, 0); // 07:00 WIB
  const { accepted } = portfolioPass([t(base, -0.6), t(base + 1000000, 1), t(base + DAY, 1)], { ...profile, maxOpen: 5 }, { ...g, dailyLossLimitSol: 0.5 });
  assert.equal(accepted.length, 2);
  assert.equal(accepted[1].entryTime, base + DAY);
});

test("totals", () => {
  const pcts = [-10, -5, -2, 0, 1, 2, 3, 4, 5, 10];
  const reasons = ["sl", "sl", "sl", "tp", "tp", "tp", "tp", "end_of_data", "end_of_data", "tp"];
  const trades = pcts.map((pnlPct, k) => ({
    entryTime: k * 1000,
    exitTime: k * 1000 + 500,
    pnlPct,
    pnlSol: pnlPct / 100,
    holdMin: k + 1,
    flipped: k < 3,
    exitReason: reasons[k],
  }));
  const { accepted, totals } = portfolioPass(trades, { ...profile, maxOpen: 1 }, { ...g, dailyLossLimitSol: 0 });
  assert.equal(accepted.length, 10);
  assert.equal(totals.trades, 10);
  assert.equal(totals.winRate, 0.6); // 6 dari 10 pnlSol > 0 (pecahan 0..1)
  assert.ok(Math.abs(totals.meanPct - 0.8) < 1e-9);
  assert.equal(totals.medianPct, 1.5);
  assert.equal(totals.worst10Pct, -10);
  assert.ok(Math.abs(totals.totalSol - 0.08) < 1e-9);
  assert.ok(Math.abs(totals.maxDrawdownSol - 0.17) < 1e-9); // 0 -> -0.17 setelah 3 trade pertama
  assert.equal(totals.avgHoldMin, 5.5);
  assert.equal(totals.flipRate, 0.3);
  assert.deepEqual(totals.exitMix, { sl: 3, tp: 5, end_of_data: 2 });
});

test("totals of an empty list", () => {
  const { accepted, totals } = portfolioPass([], profile, g);
  assert.deepEqual(accepted, []);
  assert.equal(totals.trades, 0);
  assert.equal(totals.winRate, 0);
  assert.deepEqual(totals.exitMix, {});
});

test("mulberry32 is deterministic", () => {
  const a = mulberry32(1);
  const b = mulberry32(1);
  assert.equal(a(), b());
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test("sampleParams draws only from the space and expands pairs", () => {
  const s = sampleParams({ ...SEARCH_SPACE.common, ...SEARCH_SPACE.degen }, mulberry32(7));
  assert.ok(SEARCH_SPACE.common.flipPct.includes(s.flipPct));
  assert.ok(SEARCH_SPACE.degen.maxHoldMin.includes(s.maxHoldMin));
  assert.ok("trailStartPct" in s && "trailDistancePct" in s && "volatilityMinPct" in s && "volatilityMaxPct" in s);
  assert.ok(!("trail" in s) && !("volatility" in s));
});

test("scoreTrades", () => {
  const t = (pct) => ({ pnlPct: pct, pnlSol: pct / 100, exitTime: 0, holdMin: 1, flipped: false, exitReason: "tp" });
  assert.equal(scoreTrades([t(1)], { minTrades: 2 }), -Infinity);
  const list = [...Array(9).fill(t(2)), t(-10)];
  assert.ok(Math.abs(scoreTrades(list, { minTrades: 10 }) - (0.8 - 5)) < 1e-9);
});

test("optimize splits by time and ranks by validation", () => {
  const a = cycle(0);
  const b = cycle(a[a.length - 1].time);
  const c = cycle(b[b.length - 1].time);
  const bars = [...a, ...b, ...c, ...cycle(c[c.length - 1].time)];
  const row = { ...rowFixture, tvlUsd: 100 };
  const barsByPool = new Map([["POOL", bars]]);
  const args = {
    dataset: { pools: [{ row, token: goodToken }] },
    barsByPool,
    baseP: profile,
    g: { ...g, cooldownMin: 0, cooldownLossMin: 0 },
    solUsdAt,
    samples: 5,
    seed: 3,
    minTrades: 1,
    space: { flipPct: [40, 60], slPct: [0, 10] },
  };
  const { cutoffSec, results } = optimize(args);
  const span = bars[bars.length - 1].time - bars[0].time;
  assert.equal(cutoffSec, bars[0].time + 0.7 * span);
  assert.ok(results.length > 0 && results.length <= 10);
  for (const r of results) {
    assert.ok(r.train.trades > 0 && r.validate.trades >= 0);
    assert.ok(r.train.score > -Infinity);
    assert.ok([40, 60].includes(r.params.flipPct));
    assert.equal(r.params.name, "degen");
  }
  assert.ok(results.some((r) => r.validate.trades > 0)); // sisi validate memang berisi trade
  for (let k = 1; k < results.length; k++) assert.ok(results[k - 1].validate.score >= results[k].validate.score);
  assert.deepEqual(optimize(args), { cutoffSec, results }); // deterministik per seed
});

test("optimize returns no results when no sample reaches minTrades", () => {
  const bars = twoCycles();
  const out = optimize({
    dataset: { pools: [{ row: rowFixture, token: goodToken }] },
    barsByPool: { POOL: bars },
    baseP: profile,
    g,
    solUsdAt,
    samples: 3,
    seed: 1,
    minTrades: 20,
    space: { flipPct: [60] },
  });
  assert.deepEqual(out.results, []);
});
