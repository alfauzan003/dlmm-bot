import test from "node:test";
import assert from "node:assert/strict";
import { WSOL_MINT, USDC_MINT } from "../src/core/constants.js";
import {
  fetchOhlcvRange,
  fetchTokens,
  fetchPoolRows,
  findSolUsdPool,
  solUsdSeries,
  solUsdAtFn,
} from "../src/strategy/sources.js";

test("fetchOhlcvRange paginates windows and dedupes", async () => {
  const calls = [];
  const deps = {
    sleep: async () => {},
    fetchJson: async (url) => {
      calls.push(url);
      const s = Number(new URL(url).searchParams.get("start_time"));
      return {
        data: [
          { timestamp: s, open: 1, high: 1, low: 1, close: 1, volume: 1 },
          { timestamp: s + 300, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        ],
      };
    },
  };
  const bars = await fetchOhlcvRange("P", 0, 60000, { deps });
  assert.equal(calls.length, 3); // 60000 / 27000
  assert.deepEqual(
    bars.map((b) => b.time),
    [...new Set(bars.map((b) => b.time))].sort((a, b) => a - b)
  );
});

test("fetchOhlcvRange keeps every window at least 6900 s", async () => {
  const ranges = [];
  const deps = {
    sleep: async () => {},
    fetchJson: async (url) => {
      const q = new URL(url).searchParams;
      ranges.push(Number(q.get("end_time")) - Number(q.get("start_time")));
      return { data: [] };
    },
  };
  await fetchOhlcvRange("P", 0, 60000, { deps });
  assert.ok(ranges.every((r) => r >= 6900));
});

test("fetchTokens batches by 100 and keys by id", async () => {
  const urls = [];
  const mints = Array.from({ length: 150 }, (_, i) => `M${i}`);
  const deps = {
    now: () => 1_000,
    fetchJson: async (url) => {
      urls.push(url);
      const q = new URL(url).searchParams.get("query").split(",");
      return q.map((id) => ({ id, organicScore: 50 }));
    },
  };
  const map = await fetchTokens(mints, { deps });
  assert.equal(urls.length, 2);
  assert.equal(map.size, 150);
  assert.equal(map.get("M7").organicScore, 50);
  // cache 5 menit: panggilan kedua tidak menembak ulang
  await fetchTokens(mints, { deps });
  assert.equal(urls.length, 2);
});

test("fetchPoolRows maps pool rows and drops nulls", async () => {
  const good = {
    address: "P1",
    name: "A-SOL",
    token_x: { address: "A" },
    token_y: { address: WSOL_MINT },
    pool_config: { bin_step: 100 },
    tvl: 5000,
  };
  const deps = { fetchJson: async () => ({ data: [good, { address: "bad" }] }) };
  const rows = await fetchPoolRows("http://x", { deps });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, "P1");
});

test("findSolUsdPool picks the WSOL/USDC row", async () => {
  const deps = {
    fetchJson: async () => ({
      data: [
        { address: "P_X", token_x: { address: "X" }, token_y: { address: USDC_MINT } },
        { address: "P_SOL", token_x: { address: WSOL_MINT }, token_y: { address: USDC_MINT } },
      ],
    }),
  };
  assert.equal(await findSolUsdPool({ deps }), "P_SOL");
});

test("solUsdAtFn picks last point at or before time", () => {
  const at = solUsdAtFn([
    [0, 100],
    [300, 110],
  ]);
  assert.equal(at(299), 100);
  assert.equal(at(300), 110);
  assert.equal(at(-5), 100);
});

test("solUsdSeries inverts when SOL is Y", () => {
  assert.deepEqual(solUsdSeries([{ time: 0, close: 0.01 }], false), [[0, 100]]);
  assert.deepEqual(solUsdSeries([{ time: 0, close: 150 }], true), [[0, 150]]);
});
