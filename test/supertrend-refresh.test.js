import test from "node:test";
import assert from "node:assert/strict";
import path from "path";

const BAR = 900;
const TMP = path.join("/tmp/opencode", `st-refresh-${process.pid}.json`);
process.env.SUPERTREND_CACHE_FILE = TMP;

const { refreshSupertrend, ensureSupertrend, getSupertrend } = await import("../src/market/supertrend-state.js");

function candles(formingBar, n = 30) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + i;
    out.push({
      time: formingBar - (n - 1 - i) * BAR,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
    });
  }
  return out;
}

test("satu fetch per bar; bar baru memicu fetch lagi", async () => {
  const mint = "testmint1111111111111111111111111111111111";
  let bar = Math.floor(Date.now() / 1000 / BAR) * BAR;
  let calls = 0;
  const deps = {
    fetchCandles: async () => {
      calls++;
      return candles(bar);
    },
  };

  const s1 = await refreshSupertrend(mint, { now: bar * 1000 + 5000, deps });
  assert.ok(s1);
  assert.equal(s1.closedBar, bar - BAR);
  assert.equal(calls, 1);

  // panggilan kedua di bar yang sama tidak fetch lagi
  await refreshSupertrend(mint, { now: bar * 1000 + 7000, deps });
  assert.equal(calls, 1);

  // bar berikutnya -> fetch lagi dan closedBar maju
  bar += BAR;
  const s2 = await refreshSupertrend(mint, { now: bar * 1000 + 5000, deps });
  assert.equal(calls, 2);
  assert.equal(s2.closedBar, bar - BAR);
});

test("data tanpa bar terakhir yang tutup tidak mengunci state", async () => {
  const mint = "testmint2222222222222222222222222222222222";
  const bar = Math.floor(Date.now() / 1000 / BAR) * BAR;
  const now = bar * 1000 + 5000;
  let calls = 0;
  const deps = {
    // data berakhir di bar - 2*BAR: belum memuat bar yang baru tutup
    fetchCandles: async () => {
      calls++;
      return candles(bar - 2 * BAR);
    },
  };

  const s = await refreshSupertrend(mint, { now, deps });
  assert.equal(s, null);
  assert.equal(getSupertrend(mint, now), null);

  // belum terkunci -> percobaan berikutnya tetap fetch
  await ensureSupertrend(mint, deps);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2);
});
