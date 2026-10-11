import test from "node:test";
import assert from "node:assert/strict";
import { RANGE_PRESETS, parseCustomRange, pctToBinRange, binPriceBounds } from "../src/lp/range.js";

test("presets", () => {
  assert.deepEqual(RANGE_PRESETS, [
    { key: "narrow", label: "Narrow", below: 20, above: 20 },
    { key: "balanced", label: "Balanced", below: 45, above: 45 },
    { key: "wide", label: "Wide", below: 65, above: 65 },
    { key: "narrow_sol", label: "Narrow SOL", below: 20, above: 0 },
    { key: "balanced_sol", label: "Balanced SOL", below: 45, above: 0 },
    { key: "wide_sol", label: "Wide SOL", below: 65, above: 0 },
  ]);
});

test("custom one number is SOL only", () => {
  assert.deepEqual(parseCustomRange("45"), { below: 45, above: 0 });
  assert.deepEqual(parseCustomRange("45 10"), { below: 45, above: 10 });
  assert.equal(parseCustomRange("100"), null);
  assert.equal(parseCustomRange("0"), null);
  assert.equal(parseCustomRange("45 -1"), null);
  assert.equal(parseCustomRange("x"), null);
});

test("bin math base X", () => {
  const r = pctToBinRange({ activeBin: 1000, binStep: 100, below: 45, above: 45, baseIsX: true });
  assert.deepEqual(r, { lowerBin: 940, upperBin: 1037, binCount: 98, solOnly: false });
});

test("bin math SOL is X flips", () => {
  const r = pctToBinRange({ activeBin: 1000, binStep: 100, below: 45, above: 45, baseIsX: false });
  assert.equal(r.lowerBin, 963);
  assert.equal(r.upperBin, 1060);
});

test("SOL-only base X ends at active", () => {
  const r = pctToBinRange({ activeBin: 1000, binStep: 100, below: 45, above: 0, baseIsX: true });
  assert.equal(r.upperBin, 1000);
  assert.equal(r.solOnly, true);
});

test("binPriceBounds base X", () => {
  const { lowSol, highSol } = binPriceBounds({
    lowerBin: 0,
    upperBin: 10,
    binStep: 100,
    baseIsX: true,
    decimalsBase: 6,
    decimalsSol: 9,
  });
  assert.ok(Math.abs(lowSol - 0.001) < 1e-12);
  assert.ok(Math.abs(highSol - 0.001104622) < 1e-9);
});

test("binPriceBounds SOL is X inverts", () => {
  const { lowSol, highSol } = binPriceBounds({
    lowerBin: 0,
    upperBin: 10,
    binStep: 100,
    baseIsX: false,
    decimalsBase: 6,
    decimalsSol: 9,
  });
  assert.ok(Math.abs(lowSol - 0.000905287) < 1e-9);
  assert.ok(Math.abs(highSol - 0.001) < 1e-12);
});
