import test from "node:test";
import assert from "node:assert/strict";
import { watchPrices } from "../src/entry/price-watch.js";

function deps({ states = {}, prices = {}, onEnsure } = {}) {
  return {
    ensureSupertrend: (mint) => onEnsure?.(mint),
    getSupertrend: (mint) => states[mint] || null,
    getSupertrendFallback: () => null,
    getPrices: async (mints) => new Map(mints.map((m) => [m, prices[m]]).filter(([, v]) => v != null)),
  };
}

test("bullish + harga <= garis memicu entry", async () => {
  const { triggered } = await watchPrices(
    [{ pool: "p1", mint: "m1" }],
    deps({ states: { m1: { direction: "bullish", line: 100 } }, prices: { m1: 99 } })
  );
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].pool, "p1");
  assert.equal(triggered[0].line, 100);
  assert.equal(triggered[0].price, 99);
});

test("bullish tapi harga di atas garis tidak memicu", async () => {
  const { triggered } = await watchPrices(
    [{ pool: "p1", mint: "m1" }],
    deps({ states: { m1: { direction: "bullish", line: 100 } }, prices: { m1: 101 } })
  );
  assert.equal(triggered.length, 0);
});

test("bearish tidak dipantau sama sekali (harga tidak diambil)", async () => {
  let called = false;
  await watchPrices([{ pool: "p1", mint: "m1" }], {
    ensureSupertrend: () => {},
    getSupertrend: () => ({ direction: "bearish", line: 100 }),
    getPrices: async () => {
      called = true;
      return new Map();
    },
  });
  assert.equal(called, false);
});

test("harga tidak tersedia -> tidak memicu", async () => {
  const { triggered } = await watchPrices(
    [{ pool: "p1", mint: "m1" }],
    deps({ states: { m1: { direction: "bullish", line: 100 } }, prices: {} })
  );
  assert.equal(triggered.length, 0);
});

test("fallback garis bar sebelumnya dipakai saat garis bar ini belum siap", async () => {
  const { triggered } = await watchPrices(
    [{ pool: "p1", mint: "m1" }],
    {
      ensureSupertrend: () => {},
      getSupertrend: () => null,
      getSupertrendFallback: () => ({ direction: "bullish", line: 100 }),
      getPrices: async () => new Map([["m1", 99]]),
    }
  );
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].line, 100);
});

test("ensure dipanggil untuk tiap kandidat", async () => {
  const seen = [];
  await watchPrices(
    [
      { pool: "p1", mint: "m1" },
      { pool: "p2", mint: "m2" },
    ],
    deps({ onEnsure: (m) => seen.push(m) })
  );
  assert.deepEqual(seen, ["m1", "m2"]);
});
