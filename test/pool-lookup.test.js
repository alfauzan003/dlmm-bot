import test from "node:test";
import assert from "node:assert/strict";
import { LBCLMM_PROGRAM_IDS } from "@meteora-ag/dlmm";
import { resolveAddress, poolButtonLabel } from "../src/lp/pool-lookup.js";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";
const POOL = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
const DLMM_PROGRAM = LBCLMM_PROGRAM_IDS["mainnet-beta"];
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// Bentuk respons nyata https://dlmm.datapi.meteora.ag/pools?query=...&page_size=... (dipangkas ke field yang dipakai).
function datapiPool(address, { x = WSOL, y = MINT, tvl, vol24h, binStep = 100, baseFee = 0.25, name = "TKN-SOL" }) {
  return {
    address,
    name,
    token_x: { address: x, symbol: "X", decimals: 9 },
    token_y: { address: y, symbol: "Y", decimals: 6 },
    pool_config: { bin_step: binStep, base_fee_pct: baseFee, max_fee_pct: 0, protocol_fee_pct: 5 },
    tvl,
    volume: { "30m": 1, "1h": 2, "24h": vol24h },
  };
}

const owned = (owner) => async () => ({ owner: { toString: () => owner } });

test("pool address resolves to pool", async () => {
  const res = await resolveAddress(POOL, {
    deps: {
      getAccountInfo: owned(DLMM_PROGRAM),
      fetchJson: async () => assert.fail("datapi must not be queried for a pool address"),
      getPoolInfo: async () => ({ pool: {}, baseMint: MINT, unsupported: false, pairName: "TKN-SOL" }),
    },
  });
  assert.deepEqual(res, { type: "pool", pool: { address: POOL, name: "TKN-SOL", baseMint: MINT } });
});

test("non-SOL pool", async () => {
  const res = await resolveAddress(POOL, {
    deps: {
      getAccountInfo: owned(DLMM_PROGRAM),
      fetchJson: async () => assert.fail("no datapi"),
      getPoolInfo: async () => ({ pool: {}, baseMint: null, unsupported: true, pairName: "JUP-USDC" }),
    },
  });
  assert.deepEqual(res, { type: "not_sol", pair: "JUP-USDC" });
});

test("mint resolves to top 5 SOL pools by TVL", async () => {
  let url = null;
  const data = [
    datapiPool("P1", { tvl: 1000, vol24h: 10 }),
    datapiPool("P2", { tvl: 90000, vol24h: 20, x: MINT, y: WSOL }),
    datapiPool("P3", { tvl: 500000, vol24h: 30, x: USDC, y: MINT, name: "TKN-USDC" }),
    datapiPool("P4", { tvl: 30000, vol24h: 40 }),
    datapiPool("P5", { tvl: 70000, vol24h: 50 }),
    datapiPool("P6", { tvl: 5000, vol24h: 60 }),
    datapiPool("P7", { tvl: 120000, vol24h: 70, binStep: 20, baseFee: 0.1 }),
  ];
  const res = await resolveAddress(MINT, {
    deps: {
      getAccountInfo: owned(SYSTEM_PROGRAM),
      fetchJson: async (u) => {
        url = u;
        return { data };
      },
      getPoolInfo: async () => assert.fail("not a pool"),
    },
  });
  assert.equal(res.type, "mint");
  assert.equal(res.pools.length, 5);
  assert.deepEqual(
    res.pools.map((p) => p.address),
    ["P7", "P2", "P5", "P4", "P6"]
  );
  assert.ok(!res.pools.some((p) => p.name === "TKN-USDC"));
  assert.deepEqual(res.pools[0], {
    address: "P7",
    name: "TKN-SOL",
    binStep: 20,
    baseFeePct: 0.1,
    tvlUsd: 120000,
    volume24hUsd: 70,
  });
  assert.equal(url, `https://dlmm.datapi.meteora.ag/pools?query=${MINT}&page_size=50`);
});

test("mint account not found still queries datapi", async () => {
  const res = await resolveAddress(MINT, {
    deps: {
      getAccountInfo: async () => null,
      fetchJson: async () => ({ data: [datapiPool("P1", { tvl: 1, vol24h: 1 })] }),
      getPoolInfo: async () => assert.fail("not a pool"),
    },
  });
  assert.equal(res.type, "mint");
  assert.equal(res.pools.length, 1);
});

test("wallet address is invalid", async () => {
  const res = await resolveAddress(MINT, {
    deps: {
      getAccountInfo: owned(SYSTEM_PROGRAM),
      fetchJson: async () => ({ data: [] }),
      getPoolInfo: async () => assert.fail("not a pool"),
    },
  });
  assert.deepEqual(res, { type: "invalid", reason: "not a DLMM pool or token with a SOL pool" });
});

test("garbage text is invalid without any lookups", async () => {
  const fail = async () => assert.fail("no lookups for a malformed address");
  const res = await resolveAddress("not an address", {
    deps: { getAccountInfo: fail, fetchJson: fail, getPoolInfo: fail },
  });
  assert.deepEqual(res, { type: "invalid", reason: "not a DLMM pool or token with a SOL pool" });
});

test("poolButtonLabel compacts TVL and volume", () => {
  assert.equal(
    poolButtonLabel({ binStep: 100, baseFeePct: 0.25, tvlUsd: 120000, volume24hUsd: 1200000 }),
    "bin 100 · 0.25% · TVL $120K · Vol $1.2M"
  );
  assert.equal(
    poolButtonLabel({ binStep: 20, baseFeePct: 1, tvlUsd: 950, volume24hUsd: 0 }),
    "bin 20 · 1% · TVL $950 · Vol $0"
  );
});
