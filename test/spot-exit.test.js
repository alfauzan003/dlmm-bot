import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-spot-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { trackPosition, getTrackedPosition, recordTrackedRange } = await import("../src/state/positions.js");
const { evaluateExit, isExitWarmup } = await import("../src/exit/rules.js");
const { fallbackBinRange } = await import("../src/meteora/open-token-position.js");
const config = (await import("../src/config/index.js")).default;

const POOL = "PoolSpot1111111111111111111111111111111111";
const POS = "PosSpot11111111111111111111111111111111111";

const LOWER = 100;
const UPPER = 300;

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

function makePosition(activeBin, overrides = {}) {
  return {
    position: POS,
    pool: POOL,
    mode: "spot",
    activeBin,
    lowerBin: LOWER,
    upperBin: UPPER,
    pnlPct: 0,
    baseMint: "mint",
    xIsSol: false,
    hasX: true,
    hasY: false,
    ...overrides,
  };
}

test("recordTrackedRange mencatat lower/upper/span sekali saja", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  recordTrackedRange(POS, LOWER, UPPER);
  let p = getTrackedPosition(POS);
  assert.equal(p.lowerBin, LOWER);
  assert.equal(p.upperBin, UPPER);
  assert.equal(p.binSpan, UPPER - LOWER);

  // Panggilan kedua tidak menimpa.
  recordTrackedRange(POS, 500, 700);
  p = getTrackedPosition(POS);
  assert.equal(p.lowerBin, LOWER);
  assert.equal(p.binSpan, UPPER - LOWER);
});

test("isExitWarmup: aktif di bawah ambang, berhenti tepat di ambang", () => {
  const now = 1_700_000_000_000;
  assert.equal(isExitWarmup(now, 30, now), true);
  assert.equal(isExitWarmup(now - 29 * 60000, 30, now), true);
  assert.equal(isExitWarmup(now - 30 * 60000, 30, now), false);
  assert.equal(isExitWarmup(now - 31 * 60000, 30, now), false);
});

test("isExitWarmup: nonaktif bila menit 0 atau data tidak valid", () => {
  const now = 1_700_000_000_000;
  assert.equal(isExitWarmup(now, 0, now), false);
  assert.equal(isExitWarmup(null, 30, now), false);
  assert.equal(isExitWarmup(undefined, 30, now), false);
});

test("warmup spot: sinyal indikator tidak di-arm selama warmup", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const res = evaluateExit(makePosition(LOWER + 10), null, { warmup: true });
  assert.equal(res.action, "hold");
  assert.equal(res.reason, "warmup");
});

test("warmup spot: OOR kiri tetap menutup saat warmup", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const res = evaluateExit(makePosition(LOWER - 1), null, { warmup: true });
  assert.equal(res.action, "close");
  assert.equal(res.reason, "oor_kiri");
});

test("OOR kanan spot: tunggu dulu, tutup setelah lewat masa tunggu", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const minutes = config.spot.oorKananMinutes;
  assert.ok(minutes > 0, "mode spot harus punya masa tunggu OOR kanan");

  // Di atas range -> hold, timer mulai.
  let res = evaluateExit(makePosition(UPPER + 1), null);
  assert.equal(res.action, "hold");
  assert.match(res.reason, /^oor_kanan_/);

  // Simulasi sudah lewat masa tunggu.
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  state.positions[POS].oorSejak = Date.now() - (minutes + 1) * 60000;
  state.positions[POS].oorArah = "kanan";
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state));

  res = evaluateExit(makePosition(UPPER + 1), null);
  assert.equal(res.action, "close");
  assert.equal(res.reason, "oor_kanan");
});

test("OOR kanan spot: masuk range lagi membatalkan timer", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");

  let res = evaluateExit(makePosition(UPPER + 1), null);
  assert.equal(res.action, "hold");
  assert.notEqual(getTrackedPosition(POS).oorSejak, null);

  // Kembali in-range -> timer direset.
  res = evaluateExit(makePosition(UPPER), null);
  assert.notEqual(res.action, "close");
  assert.equal(getTrackedPosition(POS).oorSejak, null);

  // OOR lagi -> timer mulai dari nol (hold, bukan close).
  res = evaluateExit(makePosition(UPPER + 1), null);
  assert.equal(res.action, "hold");
  assert.match(res.reason, /^oor_kanan_/);
});

test("OOR kiri spot: tutup langsung (masa tunggu 0)", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  assert.equal(config.spot.enableOOR, true);
  assert.equal(config.spot.oorKiriMinutes, 0);

  const res = evaluateExit(makePosition(LOWER - 1), null);
  assert.equal(res.action, "close");
  assert.equal(res.reason, "oor_kiri");
});

test("fallbackBinRange menghitung batas bin satu-sisi", () => {
  assert.deepEqual(fallbackBinRange(1000, 0, 70), { minBinId: 1000, maxBinId: 1070 });
  assert.deepEqual(fallbackBinRange(1000, 5, 0), { minBinId: 995, maxBinId: 1000 });
});

test("yield rendah spot: timer lalu close setelah delay", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const pct = config.spot.lowYieldClosePct;
  const delay = config.spot.lowYieldDelayMinutes;
  assert.ok(pct > 0 && delay > 0, "spot harus punya aturan yield rendah");

  let res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct - 1, pnlPct: 0 }), null);
  assert.equal(res.action, "hold");
  assert.match(res.reason, /^low_yield_/);
  assert.notEqual(getTrackedPosition(POS).lowYieldSejak, null);

  // Simulasi sudah lewat masa tunggu.
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  state.positions[POS].lowYieldSejak = Date.now() - (delay + 1) * 60000;
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state));

  res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct - 1, pnlPct: 0 }), null);
  assert.equal(res.action, "close");
  assert.equal(res.reason, "low_yield");
});

test("yield rendah spot: yield naik membatalkan timer", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const pct = config.spot.lowYieldClosePct;

  let res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct - 1 }), null);
  assert.equal(res.action, "hold");
  assert.notEqual(getTrackedPosition(POS).lowYieldSejak, null);

  res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct + 5 }), null);
  assert.notEqual(res.action, "close");
  assert.equal(getTrackedPosition(POS).lowYieldSejak, null);
});

test("yield rendah spot: PnL minus atau data kosong tidak memicu", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const pct = config.spot.lowYieldClosePct;

  let res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct - 1, pnlPct: -1 }), null);
  assert.notEqual(res.action, "close");
  assert.equal(getTrackedPosition(POS).lowYieldSejak, null);

  res = evaluateExit(makePosition(LOWER + 10, { feePct24h: null, pnlPct: 0 }), null);
  assert.notEqual(res.action, "close");
  assert.equal(getTrackedPosition(POS).lowYieldSejak, null);
});

test("yield rendah spot: keluar range membatalkan timer", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const pct = config.spot.lowYieldClosePct;

  let res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct - 1 }), null);
  assert.equal(res.action, "hold");
  assert.notEqual(getTrackedPosition(POS).lowYieldSejak, null);

  res = evaluateExit(makePosition(LOWER - 1, { feePct24h: pct - 1 }), null);
  assert.equal(res.reason, "oor_kiri");
  assert.equal(getTrackedPosition(POS).lowYieldSejak, null);
});
