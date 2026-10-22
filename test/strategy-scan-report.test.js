import test from "node:test";
import assert from "node:assert/strict";
import { buildProfile } from "../src/strategy/params.js";
import {
  emptyFunnel,
  bump,
  fmtCounts,
  tokenDetail,
  volatilityDetail,
  signalDetail,
  limitDetail,
  funnelLine,
  candidateLine,
  emptyDigest,
  addScan,
  buildDigestText,
} from "../src/strategy/scan-report.js";

const P = { ...buildProfile({}, "degen"), minPumpPct: 8, minPullbackPct: 5, maxPullbackPct: 35, pumpLookbackMin: 30 };
const G = { organicScoreMin: 60, topHoldersMaxPct: 30 };

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
    volatilityPct: 4.06,
    signal: "no_pump",
    detail: "pump 3.2% < min 8% in 30m",
  };
  assert.equal(
    candidateLine("degen", c),
    "Auto entry degen · FOO-SOL → no_pump (pump 3.2% < min 8% in 30m) · fee/TVL 1.23% · vol 4.1%"
  );
  assert.equal(
    candidateLine("degen", { ...c, pairName: "", volatilityPct: null, detail: null }),
    "Auto entry degen · Pool1111… → no_pump · fee/TVL 1.23%"
  );
});

test("detail helpers name the number and the threshold", () => {
  assert.equal(tokenDetail("organic", { organicScore: 41 }, G), "organic score 41 < 60");
  assert.equal(tokenDetail("top_holders", { audit: { topHoldersPercentage: 45 } }, G), "top holders 45% > 30%");
  assert.equal(tokenDetail("no_token", undefined, G), "no Jupiter token info");
  assert.match(volatilityDetail(null, P), /n\/a/);
  assert.equal(
    volatilityDetail(12.34, { volatilityMinPct: 2, volatilityMaxPct: 10 }),
    "volatility 12.3% outside 2–10%"
  );
  const m = { pumpPct: 3.21, pullbackPct: 1 };
  assert.equal(signalDetail({ reason: "no_pump", metrics: m }, P), "pump 3.2% < min 8% in 30m");
  assert.equal(
    signalDetail({ reason: "pullback_large", metrics: { pumpPct: 20, pullbackPct: 40 } }, P),
    "pump 20.0% · pullback 40.0% > max 35%"
  );
  assert.equal(
    signalDetail({ reason: "not_red", metrics: { pumpPct: 20, pullbackPct: 10 } }, P),
    "pump 20.0% · pullback 10.0% · last bar not red"
  );
  assert.equal(signalDetail({ reason: "immediate", metrics: null }, P), "immediate timing");
  assert.equal(limitDetail("max_open", { maxOpen: 2 }), "profile already has 2 open trade(s)");
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
    /first scan · LIVE[\s\S]*No profile is on/
  );
});
