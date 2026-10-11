import test from "node:test";
import assert from "node:assert/strict";
import { checkPoolPriceDeviation, guardPoolPrice, poolPriceSolPerToken } from "../src/entry/price-guard.js";
import { WSOL_MINT } from "../src/core/constants.js";

test("poolPriceSolPerToken menghormati orientasi pool", () => {
  assert.equal(poolPriceSolPerToken({ pricePerToken: 9.66e-5 }, true), 9.66e-5);
  assert.ok(Math.abs(poolPriceSolPerToken({ pricePerToken: 9.66e-5 }, false) - 1 / 9.66e-5) < 1e-6);
  assert.equal(poolPriceSolPerToken({ pricePerToken: 0 }, true), null);
  assert.equal(poolPriceSolPerToken(null, true), null);
});

test("tolak bila harga pool jauh di atas pasar (kasus E7q)", async () => {
  const r = await checkPoolPriceDeviation({
    activeBin: { pricePerToken: 2.0511e-4 },
    baseIsX: true,
    tokenUsd: 0.0111,
    solUsd: 119.1,
    thresholdPct: 15,
  });
  assert.equal(r.ok, false);
  assert.ok(r.deviationPct > 100);
});

test("lolos bila deviasi dalam ambang (kasus CkLA +8.5%)", async () => {
  const r = await checkPoolPriceDeviation({
    activeBin: { pricePerToken: 5.4721e-6 },
    baseIsX: true,
    tokenUsd: 5.0444e-6 * 119.1,
    solUsd: 119.1,
    thresholdPct: 15,
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.deviationPct - 8.5) < 0.5);
});

test("harga token null memicu fetch (kasus DCA price:null)", async () => {
  let called = false;
  const r = await checkPoolPriceDeviation({
    baseMint: "mintA",
    activeBin: { pricePerToken: 2.0511e-4 },
    baseIsX: true,
    tokenUsd: null,
    solUsd: undefined,
    thresholdPct: 15,
    fetchPrices: async (mints) => {
      called = true;
      assert.deepEqual(mints, ["mintA", WSOL_MINT]);
      return new Map([
        ["mintA", 0.0111],
        [WSOL_MINT, 119.1],
      ]);
    },
  });
  assert.equal(called, true);
  assert.equal(r.ok, false);
});

test("harga pasar tidak tersedia -> fail-open", async () => {
  const r = await checkPoolPriceDeviation({
    activeBin: { pricePerToken: 1e-4 },
    baseIsX: true,
    tokenUsd: null,
    solUsd: null,
    thresholdPct: 15,
    fetchPrices: async () => new Map(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.unavailable, true);
});

// --- guardPoolPrice (loop retry) ---

function seqCheck(results) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  fn.calls = calls;
  return fn;
}

test("guardPoolPrice: lolos di percobaan pertama (tanpa retry)", async () => {
  let reads = 0;
  const check = seqCheck([{ ok: true, unavailable: false, deviationPct: 2 }]);
  const r = await guardPoolPrice({
    getActiveBin: async () => {
      reads++;
      return { binId: 1, pricePerToken: 1e-4 };
    },
    attempts: 3,
    delayMs: 1000,
    sleepFn: async () => {
      throw new Error("tidak boleh tidur");
    },
    check,
  });
  assert.equal(r.exhausted, false);
  assert.equal(reads, 1);
  assert.equal(check.calls.length, 1);
});

test("guardPoolPrice: retry saat menyimpang lalu lolos", async () => {
  let reads = 0;
  let slept = 0;
  const retries = [];
  const check = seqCheck([
    { ok: false, unavailable: false, deviationPct: 40 },
    { ok: false, unavailable: false, deviationPct: 25 },
    { ok: true, unavailable: false, deviationPct: 5 },
  ]);
  const r = await guardPoolPrice({
    getActiveBin: async () => {
      reads++;
      return { binId: reads, pricePerToken: 1e-4 };
    },
    attempts: 3,
    delayMs: 1000,
    sleepFn: async () => {
      slept++;
    },
    onRetry: (x) => retries.push(x.attempt),
    check,
  });
  assert.equal(r.exhausted, false);
  assert.equal(reads, 3);
  assert.equal(slept, 2);
  assert.deepEqual(retries, [1, 2]);
});

test("guardPoolPrice: 3x menyimpang -> exhausted", async () => {
  const check = seqCheck([{ ok: false, unavailable: false, deviationPct: 40 }]);
  const r = await guardPoolPrice({
    getActiveBin: async () => ({ binId: 1, pricePerToken: 1e-4 }),
    attempts: 3,
    delayMs: 0,
    check,
  });
  assert.equal(r.exhausted, true);
  assert.equal(r.attempts, 3);
  assert.equal(check.calls.length, 3);
  assert.equal(r.guard.deviationPct, 40);
});

test("guardPoolPrice: harga tak tersedia -> berhenti (fail-open)", async () => {
  let unavailable = 0;
  const check = seqCheck([
    { ok: false, unavailable: false, deviationPct: 40 },
    { ok: true, unavailable: true, reason: "tidak tersedia" },
  ]);
  const r = await guardPoolPrice({
    getActiveBin: async () => ({ binId: 1, pricePerToken: 1e-4 }),
    attempts: 3,
    delayMs: 0,
    check,
    onUnavailable: () => unavailable++,
  });
  assert.equal(r.exhausted, false);
  assert.equal(check.calls.length, 2);
  assert.equal(unavailable, 1);
});

test("guardPoolPrice: retry pakai harga pasar segar (signal hanya percobaan 1)", async () => {
  const check = seqCheck([{ ok: false, unavailable: false, deviationPct: 40 }]);
  await guardPoolPrice({
    getActiveBin: async () => ({ binId: 1, pricePerToken: 1e-4 }),
    signalTokenUsd: 0.01,
    signalSolUsd: 119,
    attempts: 3,
    delayMs: 0,
    check,
  });
  assert.equal(check.calls[0].tokenUsd, 0.01);
  assert.equal(check.calls[0].solUsd, 119);
  assert.equal(check.calls[1].tokenUsd, undefined);
  assert.equal(check.calls[1].solUsd, undefined);
  assert.equal(check.calls[2].tokenUsd, undefined);
});
