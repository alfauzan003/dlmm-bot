import test from "node:test";
import assert from "node:assert/strict";
import config from "../src/config/index.js";
import { WSOL_MINT, USDC_MINT } from "../src/core/constants.js";
import {
  fetchOhlcvRange,
  fetchTokens,
  fetchPoolRows,
  findSolUsdPool,
  solUsdSeries,
  solUsdAtFn,
  resetMeteoraPace,
  countPoolLps,
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
  const deps = { sleep: async () => {}, fetchJson: async () => ({ data: [good, { address: "bad" }] }) };
  const rows = await fetchPoolRows("http://x", { deps });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, "P1");
});

test("findSolUsdPool picks the WSOL/USDC row", async () => {
  const deps = {
    sleep: async () => {},
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

test("Meteora pacing is shared across calls and endpoints", async () => {
  resetMeteoraPace();
  const gap = 60000 / config.meteoraMaxPerMin;
  const sleeps = [];
  const deps = {
    now: () => 1_000_000,
    sleep: async (ms) => sleeps.push(ms),
    fetchJson: async (url) => (url.includes("/ohlcv") ? { data: [] } : { data: [] }),
  };
  await fetchOhlcvRange("P", 0, 60000, { deps }); // 3 request: 1 pertama tanpa jeda
  assert.deepEqual(sleeps, [gap, gap]);
  await fetchOhlcvRange("Q", 0, 7000, { deps }); // call baru tetap menunggu
  assert.deepEqual(sleeps, [gap, gap, gap]);
  await fetchPoolRows("http://x", { deps });
  await findSolUsdPool({ deps }).catch(() => {});
  assert.equal(sleeps.length, 5);
  assert.ok(sleeps.every((ms) => ms === gap));
});

test("fetchOhlcvRange drops bars with non-finite fields", async () => {
  const ok = { timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 };
  const deps = {
    sleep: async () => {},
    fetchJson: async () => ({
      data: [
        ok,
        { ...ok, timestamp: 300, close: null },
        { ...ok, timestamp: 600, volume: "x" },
        { ...ok, timestamp: 900 },
      ],
    }),
  };
  const bars = await fetchOhlcvRange("P", 0, 7000, { deps });
  assert.deepEqual(
    bars.map((b) => b.time),
    [0, 900]
  );
});

test("fetchTokens routes by Jupiter key", async () => {
  const saved = [config.jupiterSwapApiKey, config.jupiterPriceApiKey];
  const seen = [];
  const deps = {
    now: () => 1,
    fetchJson: async (url, opts) => {
      seen.push({ url, headers: opts?.headers });
      return [];
    },
  };
  try {
    config.jupiterSwapApiKey = "test-key";
    await fetchTokens(["K1"], { deps });
    config.jupiterSwapApiKey = "";
    config.jupiterPriceApiKey = "";
    await fetchTokens(["K2"], { deps });
  } finally {
    [config.jupiterSwapApiKey, config.jupiterPriceApiKey] = saved;
  }
  assert.ok(seen[0].url.startsWith("https://api.jup.ag/tokens/v2/search?"));
  assert.equal(seen[0].headers["x-api-key"], "test-key");
  assert.ok(seen[1].url.startsWith("https://lite-api.jup.ag/tokens/v2/search?"));
  assert.ok(!seen[1].headers || !("x-api-key" in seen[1].headers));
});

test("countPoolLps counts distinct owners, caches per pool, null on error", async () => {
  const owner = (b) => ({ account: { data: Buffer.alloc(32, b) } });
  const seen = [];
  const connection = {
    getProgramAccounts: async (programId, opts) => {
      seen.push({ programId: programId.toBase58(), opts });
      return [owner(1), owner(2), owner(1)];
    },
  };
  const deps = { now: () => 1_000, getConnection: () => connection };
  assert.equal(await countPoolLps(WSOL_MINT, { deps }), 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].programId, "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  assert.deepEqual(seen[0].opts.dataSlice, { offset: 40, length: 32 });
  assert.equal(seen[0].opts.filters.length, 2);
  assert.equal(seen[0].opts.filters[1].memcmp.offset, 8); // lb_pair
  // cache 10 menit
  assert.equal(await countPoolLps(WSOL_MINT, { deps }), 2);
  assert.equal(seen.length, 1);

  const failing = { getProgramAccounts: async () => Promise.reject(new Error("rpc down")) };
  assert.equal(await countPoolLps(USDC_MINT, { deps: { now: () => 1_000, getConnection: () => failing } }), null);
});
