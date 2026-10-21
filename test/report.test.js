import test from "node:test";
import assert from "node:assert/strict";
import { buildSummaryBlock, clock } from "../src/core/report.js";

function blockWith(watch) {
  return buildSummaryBlock({ mode: "LIVE", now: Date.now(), watched: [watch] });
}

test("watched candidate line shows profile, fee/TVL, volatility and signal", () => {
  const block = blockWith({
    profile: "degen",
    pairName: "AAA-SOL",
    pool: "P",
    feeTvl30mPct: 0.85,
    volatilityPct: 3.1,
    signal: "signal",
  });
  assert.ok(block.includes("AAA-SOL | degen | fee/TVL 0.85% | vol 3.1% | signal"));
});

test("watched candidate without pair name or volatility", () => {
  const block = blockWith({ profile: "multihour", pairName: null, pool: "PoolAbcdef123", feeTvl30mPct: 1, volatilityPct: null, signal: "organic" });
  assert.ok(block.includes("PoolAbcd… | multihour | fee/TVL 1.00% | vol ? | organic"));
});

test("clock menampilkan WIB (UTC+7)", () => {
  const ts = Date.UTC(2026, 8, 20, 0, 15, 44);
  assert.equal(clock(ts), "20 Sep 2026 07:15:44 WIB");
});
