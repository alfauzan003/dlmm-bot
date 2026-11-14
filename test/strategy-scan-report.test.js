import test from "node:test";
import assert from "node:assert/strict";
import { buildProfile } from "../src/strategy/params.js";
import {
  emptyFunnel,
  bump,
  fmtCounts,
  tokenDetail,
  signalDetail,
  limitDetail,
  funnelLine,
  candidateLine,
  emptyDigest,
  addScan,
  buildDigestText,
} from "../src/strategy/scan-report.js";

const P = buildProfile({}, "bidask_flip");
const HOUR = 3600000;

test("fmtCounts sorts by count, then name", () => {
  assert.equal(fmtCounts({ tvl: 2, fee_tvl: 5, age: 2 }), "fee_tvl 5, age 2, tvl 2");
  assert.equal(fmtCounts({}), "");
});

test("funnelLine shows each stage and the drop reasons", () => {
  const f = emptyFunnel();
  f.fetched = 100;
  for (let i = 0; i < 3; i++) bump(f.filtered, "fee_tvl");
  bump(f.filtered, "tvl");
  f.passed = 96;
  f.tokens = 90;
  bump(f.limited, "cooldown");
  f.checked = 5;
  assert.equal(
    funnelLine("degen", f),
    "Auto entry degen scan: 100 pools → filters −4 (fee_tvl 3, tvl 1) → 96 pass → 90 tokens → limits −1 (cooldown 1) → 5 checked"
  );
  assert.equal(
    funnelLine("degen", { ...emptyFunnel(), error: "pool list failed: HTTP 500" }),
    "Auto entry degen scan: pool list failed: HTTP 500"
  );
});

test("candidateLine includes verdict, detail and metrics", () => {
  const c = {
    pairName: "FOO-SOL",
    pool: "Pool1111",
    feeTvl30mPct: 1.234,
    feeActiveTvl30mPct: 2.345,
    volatilityPct: 4.06,
    signal: "above_fib",
    detail: "price above fib 0.382",
  };
  assert.equal(
    candidateLine("bidask_flip", c),
    "Auto entry bidask_flip · FOO-SOL → above_fib (price above fib 0.382) · fee/active TVL 2.35% · vol 4.1"
  );
  assert.equal(
    candidateLine("bidask_flip", { ...c, pairName: "", volatilityPct: null, detail: null }),
    "Auto entry bidask_flip · Pool1111… → above_fib · fee/active TVL 2.35%"
  );
});

test("detail helpers name the number and the threshold", () => {
  const now = 100 * HOUR;
  assert.equal(tokenDetail("no_token", undefined, P, now), "no Jupiter token info");
  assert.equal(tokenDetail("mcap", { mcap: 6_000_000 }, P, now), "Jupiter mcap $6000000 outside 200000–5000000");
  assert.equal(tokenDetail("holders", { holderCount: 10 }, P, now), "Jupiter holders 10 < 500");
  assert.equal(tokenDetail("top10", { audit: { topHoldersPercentage: 45 } }, P, now), "top 10 holders 45.0% > 30%");
  assert.equal(
    tokenDetail("age", { createdAt: new Date(now - 1.5 * HOUR).toISOString() }, P, now),
    "token age 1.5h outside 2–∞h"
  );
  assert.equal(tokenDetail("authorities", {}, P, now), "mint/freeze authority not disabled");

  const m = { ath: 2, atl: 0.5, price: 1.6, fibEntry: 1.427, fibDeep: 0.821, maxPct: 42.47 };
  assert.equal(
    signalDetail({ reason: "above_fib", metrics: m }, P, "gmgn"),
    "price $1.600 · fib 0.382 $1.427 · ATL $0.5000 / ATH $2.000 → price above fib 0.382 · 5m gmgn"
  );
  assert.equal(
    signalDetail({ reason: "signal", metrics: { ...m, price: 1 } }, P, "dexpaprika"),
    "price $1.000 · fib 0.382 $1.427 · ATL $0.5000 / ATH $2.000 · max range 42.5% (to fib 0.786) · 5m dexpaprika"
  );
  assert.equal(signalDetail({ reason: "no_history", metrics: null }, P), "no ATH/ATL (not enough candles)");
  assert.equal(limitDetail("max_open", { maxOpen: 2 }), "strategy already has 2 open trade(s)");
  assert.equal(limitDetail("profile_off", {}), "strategy off");
});

test("digest sums scans per profile and lists the latest candidates", () => {
  const dg = emptyDigest();
  const f = { ...emptyFunnel(), fetched: 100, passed: 20, tokens: 18, checked: 2 };
  addScan(dg, "degen", f, [
    { pairName: "FOO-SOL", pool: "p1", signal: "no_pump", detail: "pump 3.2% < min 8% in 30m" },
    { pairName: "BAR-SOL", pool: "p2", signal: "organic", detail: "organic score 41 < 60" },
  ]);
  addScan(dg, "degen", f, [
    { pairName: "FOO-SOL", pool: "p1", signal: "no_pump", detail: "pump 4.0% < min 8% in 30m" },
  ]);
  addScan(dg, "degen", { ...emptyFunnel(), error: "pool list failed: HTTP 500" }, []);
  const text = buildDigestText(dg, { mode: "DRY RUN", minutes: 40, profilesOn: ["degen", "multihour"] });
  assert.match(text, /^🔎 Auto Entry digest · last 40m · DRY RUN/);
  assert.match(text, /degen — 3 scan\(s\), 1 error\(s\)/);
  assert.match(text, /avg\/scan: 100 pools → 20 pass → 18 tokens → 2 checked/);
  assert.match(text, /verdicts: no_pump 2 · organic 1/);
  assert.match(text, /last error: pool list failed: HTTP 500/);
  assert.match(text, /• FOO-SOL — no_pump: pump 4\.0% < min 8% in 30m/);
  assert.doesNotMatch(text, /BAR-SOL/, "latest = last successful scan only");
  assert.match(text, /multihour — no scan yet/);
  assert.match(
    buildDigestText(emptyDigest(), { mode: "LIVE", minutes: null, profilesOn: [] }),
    /first scan · LIVE[\s\S]*No strategy is on/
  );
});
