import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-cpnl-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { waitClosedPositionPnl } = await import("../src/meteora/positions.js");

const POOL = "PoolTest1111111111111111111111111111111111";
const POS = "PosTest11111111111111111111111111111111111";
const WALLET = "Wallet1111111111111111111111111111111111111";

const realFetch = global.fetch;

test.after(() => {
  global.fetch = realFetch;
});

function mockFetch(handler) {
  global.fetch = handler;
}

test("waitClosedPositionPnl: ketemu langsung (pakai pnlSolPctChange)", async () => {
  mockFetch(async () => ({
    ok: true,
    json: async () => ({
      positions: [{ positionAddress: POS, isClosed: true, pnlSolPctChange: "22.23", pnlPctChange: "21.93" }],
      hasNext: false,
    }),
  }));
  const pnl = await waitClosedPositionPnl(POOL, POS, { timeoutMs: 50, intervalMs: 1, wallet: WALLET });
  assert.equal(pnl, 22.23);
});

test("waitClosedPositionPnl: ketemu setelah retry", async () => {
  let calls = 0;
  mockFetch(async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        positions: calls < 2 ? [] : [{ positionAddress: POS, pnlSolPctChange: "18.12" }],
        hasNext: false,
      }),
    };
  });
  const pnl = await waitClosedPositionPnl(POOL, POS, { timeoutMs: 500, intervalMs: 5, wallet: WALLET });
  assert.equal(pnl, 18.12);
  assert.ok(calls >= 2, `harus retry, calls=${calls}`);
});

test("waitClosedPositionPnl: tidak ketemu sampai timeout → null", async () => {
  mockFetch(async () => ({ ok: true, json: async () => ({ positions: [], hasNext: false }) }));
  const pnl = await waitClosedPositionPnl(POOL, POS, { timeoutMs: 30, intervalMs: 5, wallet: WALLET });
  assert.equal(pnl, null);
});

test("waitClosedPositionPnl: error fetch → null (tidak melempar)", async () => {
  mockFetch(async () => {
    throw new Error("network down");
  });
  const pnl = await waitClosedPositionPnl(POOL, POS, { timeoutMs: 20, intervalMs: 5, wallet: WALLET });
  assert.equal(pnl, null);
});
