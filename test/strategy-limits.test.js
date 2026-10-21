import test from "node:test";
import assert from "node:assert/strict";
import { buildProfile, buildAutoEntry } from "../src/strategy/params.js";
import { cooldownUntil, canOpen, todayAutoPnlSol, brakeHit } from "../src/strategy/limits.js";

const g = buildAutoEntry({});
const p = { ...buildProfile({}, "degen"), maxOpen: 1 };

test("canOpen order", () => {
  assert.equal(canOpen({ p: { ...p, on: false }, open: [], closed: [], mint: "M", now: 0, g }).reason, "profile_off");
  assert.equal(canOpen({ p, open: [{ profile: "degen", baseMint: "X" }], closed: [], mint: "M", now: 0, g }).reason, "max_open");
  assert.equal(canOpen({ p: { ...p, maxOpen: 2 }, open: [{ profile: "multihour", baseMint: "M" }], closed: [], mint: "M", now: 0, g }).reason, "token_open");
  assert.equal(canOpen({ p, open: [], closed: [], mint: "M", now: 0, g }).ok, true);
});

test("cooldown from closed trades: 2h after win, 12h after loss", () => {
  const win = [{ baseMint: "M", closedAt: 0, closePnlUsd: 1 }];
  const loss = [{ baseMint: "M", closedAt: 0, closePnlSol: -0.01, closePnlUsd: 5 }];
  assert.equal(cooldownUntil(win, "M", g), 120 * 60000);
  assert.equal(cooldownUntil(loss, "M", g), 720 * 60000);
  assert.equal(cooldownUntil([], "M", g), 0);
  assert.equal(canOpen({ p, open: [], closed: win, mint: "M", now: 119 * 60000, g }).reason, "cooldown");
  assert.equal(canOpen({ p, open: [], closed: win, mint: "M", now: 120 * 60000, g }).ok, true);
});

test("cooldown uses the latest close for the mint", () => {
  const closed = [
    { baseMint: "M", closedAt: 1000, closePnlSol: -1 },
    { baseMint: "M", closedAt: 5000, closePnlSol: 1 },
    { baseMint: "Z", closedAt: 9000, closePnlSol: -1 },
  ];
  assert.equal(cooldownUntil(closed, "M", g), 5000 + 120 * 60000);
});

test("todayAutoPnlSol mixes SOL and USD; skips USD when no SOL price", () => {
  const now = Date.UTC(2026, 9, 21, 10); // 17:00 WIB
  const closed = [
    { baseMint: "a", closedAt: now - 3600000, closePnlSol: -0.2 },
    { baseMint: "b", closedAt: now - 3600000, closePnlUsd: -30 },
    { baseMint: "c", closedAt: now - 24 * 3600000, closePnlSol: -5 },
  ];
  assert.ok(Math.abs(todayAutoPnlSol(closed, 100, now) - -0.5) < 1e-9);
  assert.ok(Math.abs(todayAutoPnlSol(closed, null, now) - -0.2) < 1e-9);
});

test("brakeHit", () => {
  assert.equal(brakeHit(-0.5, g), true);
  assert.equal(brakeHit(-0.49, g), false);
  assert.equal(brakeHit(-9, { ...g, dailyLossLimitSol: 0 }), false);
});
