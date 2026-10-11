import test from "node:test";
import assert from "node:assert/strict";
import { parseWib, fmtWib } from "../scripts/pnl-report.js";

test("parseWib menganggap tanggal sebagai WIB (UTC+7)", () => {
  assert.equal(parseWib("2026-09-21"), Date.UTC(2026, 8, 20, 17, 0, 0));
});

test("parseWib menerima jam, baik spasi maupun T", () => {
  assert.equal(parseWib("2026-09-21 08:30"), Date.UTC(2026, 8, 21, 1, 30, 0));
  assert.equal(parseWib("2026-09-21T08:30"), Date.UTC(2026, 8, 21, 1, 30, 0));
});

test("parseWib menolak format tidak valid", () => {
  assert.equal(parseWib("kemarin"), null);
  assert.equal(parseWib("2026/09/21"), null);
});

test("fmtWib menampilkan jam WIB dari epoch detik UTC", () => {
  assert.equal(fmtWib(Date.UTC(2026, 8, 21, 1, 30, 0) / 1000), "21 Sep 08:30");
});
