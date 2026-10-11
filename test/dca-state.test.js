import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-dca-state-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { trackPosition, getTrackedPosition } = await import("../src/state/positions.js");
const {
  setDcaArmedAndTrough,
  queueDcaRebound,
  resolvePendingDca,
  markDcaTriggered,
  clearDcaTriggered,
  clearDcaState,
  resetPoolDcaState,
  markPoolDcaCloseSafeguard,
  isTrailingTpReason,
  getPoolDcaCount,
  incrementPoolDca,
  decrementPoolDca,
  resetStaleDcaPools,
} = await import("../src/state/dca.js");

const POOL = "PoolDca1111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

let seq = 0;
function newPos(pool = POOL, isDca = false) {
  const addr = `PosDca000000000000000000000000000000000${seq++}`;
  trackPosition(addr, pool, "TEST-SOL", "mint", 0, "bidask:double", isDca);
  return addr;
}

function setClosed(addr) {
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  state.positions[addr].closed = true;
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state));
}

test("arm + trail menyimpan trough terdalam", () => {
  resetState();
  const p = newPos();
  setDcaArmedAndTrough(p, -10);
  assert.equal(getTrackedPosition(p).dcaTrough, -10);
  setDcaArmedAndTrough(p, -12);
  assert.equal(getTrackedPosition(p).dcaTrough, -12);
  setDcaArmedAndTrough(p, -11);
  assert.equal(getTrackedPosition(p).dcaTrough, -12, "trough tidak boleh naik");
});

test("konfirmasi rebound bertahan -> confirmed & pending dibersihkan", () => {
  resetState();
  const p = newPos();
  setDcaArmedAndTrough(p, -12);
  queueDcaRebound(p, -12, -11);
  assert.equal(getTrackedPosition(p).pendingDcaTrough, -12);

  const r = resolvePendingDca(p, -11, 1);
  assert.equal(r.confirmed, true);
  assert.equal(getTrackedPosition(p).pendingDcaTrough, null);
});

test("konfirmasi rebound gagal -> rejected & trough diperbarui lebih dalam", () => {
  resetState();
  const p = newPos();
  setDcaArmedAndTrough(p, -12);
  queueDcaRebound(p, -12, -11);

  const r = resolvePendingDca(p, -13, 1);
  assert.equal(r.rejected, true);
  assert.equal(getTrackedPosition(p).dcaTrough, -13);
});

test("markDcaTriggered / clearDcaTriggered", () => {
  resetState();
  const p = newPos();
  markDcaTriggered(p);
  assert.equal(getTrackedPosition(p).dcaTriggered, true);
  clearDcaTriggered(p);
  assert.equal(getTrackedPosition(p).dcaTriggered, false);
});

test("counter sesi naik, decrement saat gagal, reset saat sesi berakhir", () => {
  resetState();
  assert.equal(getPoolDcaCount(POOL), 0);

  incrementPoolDca(POOL);
  assert.equal(getPoolDcaCount(POOL), 1);
  incrementPoolDca(POOL);
  assert.equal(getPoolDcaCount(POOL), 2);

  decrementPoolDca(POOL);
  assert.equal(getPoolDcaCount(POOL), 1);

  // Tidak ada pool aktif -> sesi berakhir -> reset.
  resetStaleDcaPools(new Set());
  assert.equal(getPoolDcaCount(POOL), 0);
});

test("resetStaleDcaPools hanya mereset pool yang tidak aktif", () => {
  resetState();
  incrementPoolDca(POOL);
  incrementPoolDca("OtherPool");

  resetStaleDcaPools(new Set([POOL]));
  assert.equal(getPoolDcaCount(POOL), 1, "pool aktif harus dipertahankan");
  assert.equal(getPoolDcaCount("OtherPool"), 0, "pool tidak aktif direset");
});

test("counter persisten (dibaca ulang dari file, tahan restart)", () => {
  resetState();
  incrementPoolDca(POOL);
  // getPoolDcaCount membaca file setiap panggilan -> setara baca ulang saat restart.
  assert.equal(getPoolDcaCount(POOL), 1);
});

test("clearDcaState mereset seluruh field DCA posisi", () => {
  resetState();
  const p = newPos();
  setDcaArmedAndTrough(p, -12);
  queueDcaRebound(p, -12, -11);
  markDcaTriggered(p);

  clearDcaState(p);
  const t = getTrackedPosition(p);
  assert.equal(t.dcaArmed, false);
  assert.equal(t.dcaTrough, null);
  assert.equal(t.dcaTriggered, false);
  assert.equal(t.pendingDcaTrough, null);
});

test("resetPoolDcaState reset posisi terbuka lain di pool sama, kecuali yang ditutup", () => {
  resetState();
  const other = "PoolOther111111111111111111111111111111111";
  const p1 = newPos();
  const closedDca = newPos(POOL, true);
  const p3 = newPos(other);

  for (const p of [p1, closedDca, p3]) {
    setDcaArmedAndTrough(p, -12);
    markDcaTriggered(p);
  }

  resetPoolDcaState(POOL, closedDca);

  const t1 = getTrackedPosition(p1);
  assert.equal(t1.dcaArmed, false);
  assert.equal(t1.dcaTrough, null);
  assert.equal(t1.dcaTriggered, false);

  assert.equal(getTrackedPosition(closedDca).dcaTriggered, true, "posisi yang dikecualikan tidak diubah");
  assert.equal(getTrackedPosition(p3).dcaTriggered, true, "pool lain tidak diubah");
});

test("resetPoolDcaState melewati posisi yang sudah closed", () => {
  resetState();
  const p1 = newPos();
  const p2 = newPos(POOL, true);
  setDcaArmedAndTrough(p1, -12);
  markDcaTriggered(p1);
  setClosed(p1);

  resetPoolDcaState(POOL, p2);

  assert.equal(getTrackedPosition(p1).dcaTriggered, true, "posisi closed tidak direset");
});

test("isTrailingTpReason hanya cocok untuk reason trailing TP peak", () => {
  assert.equal(isTrailingTpReason("trailing_tp: peak 12.00% -> 3.10%"), true);
  assert.equal(isTrailingTpReason("indicator_trailing(rsi_macd): peak 5.00% -> 1.00%"), false);
  assert.equal(isTrailingTpReason("stop_loss"), false);
  assert.equal(isTrailingTpReason(null), false);
  assert.equal(isTrailingTpReason(undefined), false);
});

test("markPoolDcaCloseSafeguard menandai posisi asli saja di pool yang sama", () => {
  resetState();
  const original = newPos(POOL, false);
  const dcaClosed = newPos(POOL, true);
  const dcaOpen = newPos(POOL, true);
  const otherPool = newPos("PoolOther111111111111111111111111111111111", false);
  setClosed(dcaClosed);

  const marked = markPoolDcaCloseSafeguard(POOL, dcaClosed);

  assert.equal(marked, 1, "hanya posisi asli yang ditandai");
  assert.equal(getTrackedPosition(original).dcaCloseSafeguard, true);
  assert.equal(getTrackedPosition(dcaOpen).dcaCloseSafeguard, false, "DCA lain tidak ditandai");
  assert.equal(getTrackedPosition(dcaClosed).dcaCloseSafeguard, false, "posisi yang dikecualikan tidak ditandai");
  assert.equal(getTrackedPosition(otherPool).dcaCloseSafeguard, false, "pool lain tidak ditandai");
});
