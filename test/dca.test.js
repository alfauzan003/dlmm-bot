import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDca, isDcaEligible, effectiveDcaArmPct } from "../src/state/dca.js";
import { isDcaModeEligible } from "../src/entry/dca.js";

const cfg = { enabled: true, armPct: -10, reboundPct: 1 };
const pos = (pnlPct) => ({ position: "p1", pool: "pool1", pnlPct });
const tracked = (extra = {}) => ({ position: "p1", closed: false, dcaArmed: false, dcaTrough: null, ...extra });

test("dca disabled -> noop", () => {
  const d = evaluateDca(pos(-20), tracked(), { ...cfg, enabled: false });
  assert.equal(d.action, "noop");
  assert.equal(d.reason, "disabled");
});

test("pnl null -> noop", () => {
  assert.equal(evaluateDca(pos(null), tracked(), cfg).reason, "no_pnl");
});

test("posisi closed / tidak tracked -> noop", () => {
  assert.equal(evaluateDca(pos(-20), null, cfg).reason, "not_tracked");
  assert.equal(evaluateDca(pos(-20), tracked({ closed: true }), cfg).reason, "not_tracked");
});

test("belum menyentuh ambang -> tidak arm", () => {
  const d = evaluateDca(pos(-5), tracked(), cfg);
  assert.equal(d.action, "noop");
  assert.equal(d.reason, "not_armed");
});

test("menyentuh -10 -> arm dengan trough awal", () => {
  const d = evaluateDca(pos(-10), tracked(), cfg);
  assert.equal(d.action, "arm");
  assert.equal(d.trough, -10);
});

test("armed lalu lebih dalam -> trail trough baru", () => {
  const d = evaluateDca(pos(-12), tracked({ dcaArmed: true, dcaTrough: -10 }), cfg);
  assert.equal(d.action, "trail");
  assert.equal(d.trough, -12);
});

test("rebound penuh dari trough -> queue_rebound", () => {
  const d = evaluateDca(pos(-11), tracked({ dcaArmed: true, dcaTrough: -12 }), cfg);
  assert.equal(d.action, "queue_rebound");
  assert.equal(d.trough, -12);
  assert.equal(d.current, -11);
  assert.equal(d.rebound, 1);
});

test("rebound belum cukup -> hold", () => {
  const d = evaluateDca(pos(-11.5), tracked({ dcaArmed: true, dcaTrough: -12 }), cfg);
  assert.equal(d.action, "hold");
  assert.ok(Math.abs(d.rebound - 0.5) < 1e-9);
});

test("sudah trigger -> noop (sekali per posisi)", () => {
  const d = evaluateDca(pos(-11), tracked({ dcaArmed: true, dcaTrough: -12, dcaTriggered: true }), cfg);
  assert.equal(d.action, "noop");
  assert.equal(d.reason, "already_triggered");
});

test("isDcaEligible menolak posisi closed atau sudah trigger", () => {
  assert.equal(isDcaEligible(null), false);
  assert.equal(isDcaEligible({ closed: true }), false);
  assert.equal(isDcaEligible({ dcaTriggered: true }), false);
  assert.equal(isDcaEligible({}), true);
});

test("isDcaModeEligible hanya bidask:double (default)", () => {
  assert.equal(isDcaModeEligible("bidask:double"), true);
  assert.equal(isDcaModeEligible("bidask"), true); // legacy -> bidask:double
  assert.equal(isDcaModeEligible("spot"), false);
  assert.equal(isDcaModeEligible("bidask:token"), false);
  assert.equal(isDcaModeEligible("bidask:sol"), false);
});

test("effectiveDcaArmPct: DCA#2 pakai -30 hanya saat DCA#1 sudah close", () => {
  const c = { armPct: -10, armPct2: -30 };
  assert.equal(effectiveDcaArmPct(0, false, c), -10, "DCA#1 dari posisi utama");
  assert.equal(effectiveDcaArmPct(1, true, c), -10, "DCA#1 masih open -> acuan DCA#1");
  assert.equal(effectiveDcaArmPct(1, false, c), -30, "DCA#1 close -> acuan posisi utama");
  assert.equal(effectiveDcaArmPct(2, false, c), -10, "kuota habis ditangani pemanggil");
});

test("effectiveDcaArmPct fallback ke armPct bila armPct2 tidak valid", () => {
  assert.equal(effectiveDcaArmPct(1, false, { armPct: -10 }), -10);
  assert.equal(effectiveDcaArmPct(1, false, { armPct: -10, armPct2: NaN }), -10);
});
