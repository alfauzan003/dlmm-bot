import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-entry-quota-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { countOpenByPoolAndMode } = await import("../src/state/positions.js");

const POOL_A = "PoolQuotaA1111111111111111111111111111111111";
const POOL_B = "PoolQuotaB1111111111111111111111111111111111";

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
