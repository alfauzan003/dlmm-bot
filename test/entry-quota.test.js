import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-entry-quota-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { trackPosition, countOpenByPoolAndMode, countOpenBotPositionsByPool } =
  await import("../src/state/positions.js");

const POOL_A = "PoolQuotaA1111111111111111111111111111111111";
const POOL_B = "PoolQuotaB1111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

let seq = 0;
function newPos(pool, mode, isDca = false) {
  const addr = `PosQuota000000000000000000000000000000000${seq++}`;
  trackPosition(addr, pool, "TEST-SOL", "mint", 0, mode, isDca);
  return addr;
}

function setClosed(addr) {
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  state.positions[addr].closed = true;
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state));
}

test("countOpenByPoolAndMode hanya menghitung mode yang diminta", () => {
  const positions = [
    { pool: POOL_A, mode: "bidask:double", closed: false },
    { pool: POOL_A, mode: "spot", closed: false },
    { pool: POOL_B, mode: "bidask:double", closed: false },
    { pool: POOL_B, mode: "bidask:double", closed: true },
  ];
  const counts = countOpenByPoolAndMode(positions, "bidask:double");
  assert.equal(counts.get(POOL_A), 1);
  assert.equal(counts.get(POOL_B), 1, "posisi closed tidak dihitung");
  assert.equal(counts.get("pool-lain"), undefined);
});

test("countOpenByPoolAndMode menormalkan label mode lama 'bidask'", () => {
  const counts = countOpenByPoolAndMode([{ pool: POOL_A, mode: "bidask", closed: false }], "bidask:double");
  assert.equal(counts.get(POOL_A), 1);
});

test("spot manual di pool yang sama tidak dihitung sebagai kuota bot", () => {
  resetState();
  newPos(POOL_A, "bidask:double");
  newPos(POOL_A, "spot"); // mis. posisi manual
  newPos(POOL_A, "bidask:token");
  newPos(POOL_B, "spot");

  const counts = countOpenBotPositionsByPool("bidask:double");
  assert.equal(counts.get(POOL_A), 1, "hanya bidask:double bot yang dihitung");
  assert.equal(counts.get(POOL_B), undefined);
});

test("posisi bidask:double yang sudah closed tidak dihitung", () => {
  resetState();
  const p = newPos(POOL_A, "bidask:double");
  setClosed(p);
  const counts = countOpenBotPositionsByPool("bidask:double");
  assert.equal(counts.get(POOL_A) || 0, 0);
});
