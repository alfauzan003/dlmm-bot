import test from "node:test";
import assert from "node:assert/strict";
import config from "../src/config/index.js";
import { parseFeeMode, buildFeePlan, estimateFeeSol, checkFeeCap } from "../src/solana/fees.js";

function withFees(overrides, fn) {
  const original = { ...config.entry.fees };
  Object.assign(config.entry.fees, overrides);
  try {
    return fn();
  } finally {
    Object.assign(config.entry.fees, original);
  }
}

test("parseFeeMode memetakan nilai valid dan fallback ke none", () => {
  assert.equal(parseFeeMode("none"), "none");
  assert.equal(parseFeeMode("priority"), "priority");
  assert.equal(parseFeeMode("JITO"), "jito");
  assert.equal(parseFeeMode(" both "), "both");
  assert.equal(parseFeeMode("ngawur"), "none");
  assert.equal(parseFeeMode(undefined), "none");
});

test("buildFeePlan mode none tidak menambahkan apa pun", () => {
  withFees({ mode: "none", priorityMicroLamports: 50000, jitoTipSol: 0.001 }, () => {
    const plan = buildFeePlan();
    assert.equal(plan.priorityMicroLamports, 0);
    assert.equal(plan.jitoTipLamports, 0);
  });
});

test("buildFeePlan mode both mengisi priority dan tip", () => {
  withFees({ mode: "both", priorityMicroLamports: 50000, jitoTipSol: 0.001 }, () => {
    const plan = buildFeePlan();
    assert.equal(plan.mode, "both");
    assert.equal(plan.priorityMicroLamports, 50000);
    assert.equal(plan.jitoTipLamports, 1_000_000);
  });
});

test("estimateFeeSol menjumlahkan base + priority + tip", () => {
  const plan = { mode: "both", priorityMicroLamports: 50000, computeUnitLimit: 0, jitoTipLamports: 1_000_000 };
  const sol = estimateFeeSol(plan, { computeUnits: 400_000, feePayerSignatures: 2 });
  // base 10.000 + priority 20.000 + tip 1.000.000 = 1.030.000 lamports
  assert.equal(Math.round(sol * 1e9), 1_030_000);
});

test("estimateFeeSol mode none selalu nol", () => {
  assert.equal(estimateFeeSol({ mode: "none" }, { computeUnits: 400_000 }), 0);
  assert.equal(estimateFeeSol(null), 0);
});

test("checkFeeCap menolak bila estimasi melebihi cap", () => {
  withFees({ mode: "jito", jitoTipSol: 0.01, maxSol: 0.002 }, () => {
    const plan = buildFeePlan();
    const res = checkFeeCap(plan, { computeUnits: 400_000, feePayerSignatures: 2 });
    assert.equal(res.ok, false);
    assert.ok(res.totalSol > res.cap);
  });
});

test("checkFeeCap menerima bila di bawah cap", () => {
  withFees({ mode: "jito", jitoTipSol: 0.001, maxSol: 0.002 }, () => {
    const plan = buildFeePlan();
    const res = checkFeeCap(plan, { computeUnits: 400_000, feePayerSignatures: 2 });
    assert.equal(res.ok, true);
  });
});
