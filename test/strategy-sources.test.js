import test from "node:test";
import assert from "node:assert/strict";
import config from "../src/config/index.js";
import log from "../src/core/logger.js";
import { WSOL_MINT, USDC_MINT } from "../src/core/constants.js";
import {
  fetchOhlcvRange,
  fetchRecentBars,
  fetchTokens,
  fetchPoolRows,
  findSolUsdPool,
  solUsdSeries,
  solUsdAtFn,
  resetMeteoraPace,
  countPoolLps,
  getSolUsdForced,
  fetchRecent5mUsd,
  fetchHistory1hUsd,
  fetchVolatility,
} from "../src/strategy/sources.js";
import { fetchDexPaprikaOhlcv, _resetDexPaprikaForTest } from "../src/market/dexpaprika.js";

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
    pool_address: "P1",
    name: "A-SOL",
    token_x: { address: "A" },
    token_y: { address: WSOL_MINT },
    dlmm_params: { bin_step: 100 },
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

test("fetchRecentBars requests the last (limit + 1) bars through pacing and keeps that many", async () => {
  resetMeteoraPace();
  const gap = 60000 / config.meteoraMaxPerMin;
  const nowMs = 1_800_000_000_000;
  const nowSec = nowMs / 1000;
  const urls = [];
  const sleeps = [];
  const deps = {
    now: () => nowMs,
    sleep: async (ms) => sleeps.push(ms),
    fetchJson: async (url) => {
      urls.push(url);
      // 15 bar mentah, lebih banyak dari limit + 1 = 11
      return { data: Array.from({ length: 15 }, (_, i) => ({ timestamp: nowSec - 300 * (15 - i), open: 1, high: 1, low: 1, close: 1, volume: 1 })) };
    },
  };
  await fetchPoolRows("http://x", { deps }); // request sebelumnya -> request OHLCV harus menunggu
  const bars = await fetchRecentBars("POOL", 10, { deps, now: nowMs });
  assert.equal(urls.length, 2);
  assert.ok(urls[1].includes("/pools/POOL/ohlcv?timeframe=5m"));
  const q = new URL(urls[1]).searchParams;
  assert.equal(Number(q.get("end_time")), nowSec);
  assert.equal(Number(q.get("start_time")), nowSec - 6900); // 11 * 300 s < min range 6900 s -> mundur
  assert.deepEqual(sleeps, [gap]);
  assert.equal(bars.length, 11);
  assert.equal(bars[bars.length - 1].time, nowSec - 300);
});

test("fetchRecentBars returns [] when the request fails and logs a warning", async (t) => {
  const warn = t.mock.method(log, "warn", () => {});
  resetMeteoraPace();
  const deps = {
    sleep: async () => {},
    fetchJson: async () => {
      throw new Error("HTTP 429");
    },
  };
  assert.deepEqual(await fetchRecentBars("POOLADDRESS123", 10, { deps }), []);
  assert.equal(warn.mock.callCount(), 1);
  const msg = warn.mock.calls[0].arguments[0];
  assert.ok(msg.includes("POOLADDR") && !msg.includes("POOLADDRE") && msg.includes("HTTP 429"), msg);
});

test("getSolUsdForced forces past Jupiter pacing and falls back to the last good price", async () => {
  const calls = [];
  let price = null;
  const getPrices = async (mints, opts) => {
    calls.push({ mints, opts });
    if (price === "throw") throw new Error("down");
    return new Map(price == null ? [] : [[WSOL_MINT, price]]);
  };
  const deps = { getPrices };
  assert.equal(await getSolUsdForced({ deps }), null, "no price yet");
  price = 150;
  assert.equal(await getSolUsdForced({ deps }), 150);
  price = null;
  assert.equal(await getSolUsdForced({ deps }), 150, "pacing/backoff -> last good");
  price = 0;
  assert.equal(await getSolUsdForced({ deps }), 150, "non-positive is not a price");
  price = "throw";
  assert.equal(await getSolUsdForced({ deps }), 150);
  assert.deepEqual(calls[0], { mints: [WSOL_MINT], opts: { force: true } });
  assert.ok(calls.every((c) => c.opts.force === true));
});

// ---- Candle USD untuk bidask flip (GMGN 5m, DexPaprika 1h / fallback 5m) ----

const HOUR_MS = 3600000;
const usdBar = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1 });
const ROW_USD = {
  address: "PoolUsd",
  baseMint: "MintUsd",
  basePriceUsd: 0.001,
  tokenCreatedAt: 1000 * HOUR_MS - 10 * HOUR_MS,
};

test("fetchRecent5mUsd: GMGN first, 100 bars of 5m", async () => {
  const asked = [];
  const r = await fetchRecent5mUsd(ROW_USD, {
    deps: {
      fetchGmgnKline: async (mint, opts) => {
        asked.push([mint, opts]);
        return [usdBar(0, 0.001)];
      },
      fetchDexPaprikaOhlcv: async () => assert.fail("no fallback when GMGN works"),
    },
  });
  assert.deepEqual(asked, [["MintUsd", { resolution: "5m", limit: 100 }]]);
  assert.equal(r.source, "gmgn");
  assert.equal(r.bars.length, 1);
});

test("fetchRecent5mUsd: GMGN failure falls back to DexPaprika 5m; both failing returns both errors", async () => {
  const now = 1000 * HOUR_MS;
  const seen = [];
  const r = await fetchRecent5mUsd(ROW_USD, {
    deps: {
      now: () => now,
      fetchGmgnKline: async () => Promise.reject(new Error("RATE_LIMIT")),
      fetchDexPaprikaOhlcv: async (pool, opts) => {
        seen.push([pool, opts]);
        return [usdBar(0, 0.0011)];
      },
    },
  });
  assert.equal(r.source, "dexpaprika");
  assert.deepEqual(seen, [["PoolUsd", { interval: "5m", startSec: now / 1000 - 30000, endSec: now / 1000, inversed: false }]]);

  const bad = await fetchRecent5mUsd(ROW_USD, {
    deps: {
      fetchGmgnKline: async () => [],
      fetchDexPaprikaOhlcv: async () => Promise.reject(new Error("DexPaprika HTTP 403 plan_required")),
    },
  });
  assert.deepEqual(bad.bars, []);
  assert.equal(bad.error, "GMGN: no candles · DexPaprika: DexPaprika HTTP 403 plan_required");
});

test("fetchHistory1hUsd: from token birth, capped by DEXPAPRIKA_HISTORY_DAYS; picks the side near the token price", async () => {
  const now = 1000 * HOUR_MS;
  const before = config.autoEntry.dexpaprikaHistoryDays;
  try {
    config.autoEntry.dexpaprikaHistoryDays = 7;
    const seen = [];
    const fetchDexPaprikaOhlcv = async (pool, opts) => {
      seen.push(opts);
      return [usdBar(0, opts.inversed ? 0.0012 : 150)]; // default = harga SOL (salah sisi)
    };
    const bars = await fetchHistory1hUsd(ROW_USD, { refUsd: 0.001, deps: { now: () => now, fetchDexPaprikaOhlcv } });
    assert.equal(bars[0].close, 0.0012);
    assert.deepEqual(
      seen.map((o) => [o.interval, o.startSec, o.endSec, o.inversed]),
      [
        ["1h", (now - 10 * HOUR_MS) / 1000, now / 1000, false],
        ["1h", (now - 10 * HOUR_MS) / 1000, now / 1000, true],
      ]
    );
    // Token lebih tua dari jendela plan -> mulai dari now − 7 hari.
    seen.length = 0;
    await fetchHistory1hUsd({ ...ROW_USD, tokenCreatedAt: now - 30 * 24 * HOUR_MS }, { refUsd: 150, deps: { now: () => now, fetchDexPaprikaOhlcv } });
    assert.deepEqual(seen.map((o) => o.startSec), [now / 1000 - 7 * 86400]);
    // Kedua sisi jauh dari harga acuan -> error.
    await assert.rejects(
      fetchHistory1hUsd(ROW_USD, { refUsd: 5, deps: { now: () => now, fetchDexPaprikaOhlcv } }),
      /does not match the token price/
    );
  } finally {
    config.autoEntry.dexpaprikaHistoryDays = before;
  }
});

test("fetchDexPaprikaOhlcv: URL, key header, paging, dedupe and bad bars dropped", async () => {
  _resetDexPaprikaForTest();
  const before = [config.dexpaprikaApiKey, config.dexpaprikaApiUrl];
  config.dexpaprikaApiKey = "test-key";
  config.dexpaprikaApiUrl = "https://dp.test";
  try {
    const calls = [];
    const iso = (sec) => new Date(sec * 1000).toISOString();
    const fetchJson = async (url, opts) => {
      calls.push({ url: new URL(url), headers: opts?.headers });
      const start = Number(new URL(url).searchParams.get("start"));
      return [
        { time_open: iso(start), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { time_open: iso(start), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }, // duplikat
        { time_open: iso(start + 3600), open: 0, high: 2, low: 0.5, close: 1.5, volume: 10 }, // harga 0
      ];
    };
    const bars = await fetchDexPaprikaOhlcv("PoolX", {
      interval: "1h",
      startSec: 0,
      endSec: 1500 * 3600,
      inversed: true,
      deps: { fetchJson, sleep: async () => {}, now: () => 0 },
    });
    assert.equal(calls.length, 2, "1500 bars -> 2 pages of 1000");
    assert.equal(calls[0].url.origin + calls[0].url.pathname, "https://dp.test/networks/solana/pools/PoolX/ohlcv");
    assert.deepEqual(
      ["start", "end", "interval", "limit", "inversed"].map((k) => calls[0].url.searchParams.get(k)),
      ["0", String(1000 * 3600), "1h", "1000", "true"]
    );
    assert.equal(calls[1].url.searchParams.get("start"), String(1000 * 3600));
    assert.deepEqual(calls[0].headers, { Authorization: "test-key" });
    assert.deepEqual(bars.map((b) => b.time), [0, 1000 * 3600]);
    await assert.rejects(fetchDexPaprikaOhlcv("PoolX", { interval: "2h", startSec: 0, endSec: 1 }), /tidak didukung/);
  } finally {
    [config.dexpaprikaApiKey, config.dexpaprikaApiUrl] = before;
  }
});

test("fetchVolatility: one 24h request for the given pools, missing values left out", async () => {
  const urls = [];
  const deps = {
    sleep: async () => {},
    fetchJson: async (url) => {
      urls.push(new URL(url));
      return { data: [{ pool_address: "P1", volatility: 4.1 }, { pool_address: "P2", volatility: null }] };
    },
  };
  const vols = await fetchVolatility(["P1", "P2"], { deps });
  assert.deepEqual([...vols], [["P1", 4.1]]);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get("timeframe"), "24h");
  assert.equal(urls[0].searchParams.get("filter_by"), "pool_address=[P1,P2]");
  assert.deepEqual([...(await fetchVolatility([], { deps }))], []);
  assert.equal(urls.length, 1, "no request for an empty list");
});
