import test from "node:test";
import assert from "node:assert/strict";

const { periodStart, summarize } = await import("../src/lp/pnl-stats.js");

test("today starts at WIB midnight", () => {
  assert.equal(periodStart("today", Date.UTC(2026, 9, 11, 2, 0)), Date.UTC(2026, 9, 10, 17, 0));
});

test("week starts Monday WIB", () => {
  // Minggu 2026-10-11 09:00 WIB -> Senin 2026-10-05 00:00 WIB
  assert.equal(periodStart("week", Date.UTC(2026, 9, 11, 2, 0)), Date.UTC(2026, 9, 4, 17, 0));
  // Senin 00:30 WIB sudah masuk minggu yang baru
  assert.equal(periodStart("week", Date.UTC(2026, 9, 4, 17, 30)), Date.UTC(2026, 9, 4, 17, 0));
});

test("month starts on the 1st WIB", () => {
  assert.equal(periodStart("month", Date.UTC(2026, 9, 11, 2, 0)), Date.UTC(2026, 8, 30, 17, 0));
});

test("just after WIB midnight belongs to the new day", () => {
  assert.equal(periodStart("today", Date.UTC(2026, 9, 10, 17, 1)), Date.UTC(2026, 9, 10, 17, 0));
  assert.equal(periodStart("today", Date.UTC(2026, 9, 10, 16, 59)), Date.UTC(2026, 9, 9, 17, 0));
});

test("periodStart rejects an unknown period", () => {
  assert.throws(() => periodStart("year"));
});

test("summarize counts unknown PnL but leaves it out of the sums", () => {
  const trades = [
    { id: 1, closePnlUsd: 3 },
    { id: 2, closePnlUsd: -1 },
    { id: 3, closePnlUsd: null },
  ];
  const s = summarize(trades);
  assert.equal(s.count, 3);
  assert.equal(s.wins, 1);
  assert.equal(s.pnlUsd, 2);
  assert.equal(s.winRatePct, 50);
  assert.equal(s.best.id, 1);
  assert.equal(s.worst.id, 2);
});

test("summarize with no known PnL has no win rate, best or worst", () => {
  const s = summarize([{ id: 1, closePnlUsd: null }]);
  assert.deepEqual(s, { count: 1, wins: 0, winRatePct: null, pnlUsd: 0, best: null, worst: null });
  assert.equal(summarize([]).count, 0);
});
