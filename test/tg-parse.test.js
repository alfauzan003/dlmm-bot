import test from "node:test";
import assert from "node:assert/strict";
import { parseExitInput, parseSolAmount, extractAddress } from "../src/tg/parse.js";

const POOL = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y";

test("parseExitInput tp / sl", () => {
  assert.deepEqual(parseExitInput("tp", "15"), { on: true, pct: 15 });
  assert.deepEqual(parseExitInput("tp", " 12.5 "), { on: true, pct: 12.5 });
  assert.deepEqual(parseExitInput("sl", "-25"), { on: true, pct: 25 });
  assert.deepEqual(parseExitInput("sl", "+25"), { on: true, pct: 25 });
  assert.deepEqual(parseExitInput("tp", "1000"), { on: true, pct: 1000 });
});

test("parseExitInput off in any case", () => {
  assert.deepEqual(parseExitInput("tp", "OFF"), { on: false });
  assert.deepEqual(parseExitInput("sl", " off "), { on: false });
  assert.deepEqual(parseExitInput("trail", "Off"), { on: false });
});

test("parseExitInput trail takes start and distance", () => {
  assert.deepEqual(parseExitInput("trail", "5 3"), { on: true, startPct: 5, distancePct: 3 });
  assert.deepEqual(parseExitInput("trail", "0 2.5"), { on: true, startPct: 0, distancePct: 2.5 });
  assert.equal(parseExitInput("trail", "5"), null);
  assert.equal(parseExitInput("trail", "5 3 1"), null);
  assert.equal(parseExitInput("trail", "5 0"), null);
  assert.equal(parseExitInput("trail", "-1 3"), null);
});

test("parseExitInput rejects bad values", () => {
  assert.equal(parseExitInput("tp", "abc"), null);
  assert.equal(parseExitInput("tp", ""), null);
  assert.equal(parseExitInput("tp", "0"), null);
  assert.equal(parseExitInput("tp", "-5"), null);
  assert.equal(parseExitInput("tp", "1001"), null);
  assert.equal(parseExitInput("sl", "0"), null);
  assert.equal(parseExitInput("sl", "1e2"), null);
  assert.equal(parseExitInput("tp", "15 20"), null);
  assert.equal(parseExitInput("nope", "15"), null);
});

test("parseSolAmount", () => {
  assert.equal(parseSolAmount("0,3"), 0.3);
  assert.equal(parseSolAmount("0.7"), 0.7);
  assert.equal(parseSolAmount(" 2 "), 2);
  assert.equal(parseSolAmount("-1"), null);
  assert.equal(parseSolAmount("0"), null);
  assert.equal(parseSolAmount("abc"), null);
  assert.equal(parseSolAmount(""), null);
  assert.equal(parseSolAmount("1e3"), null);
});

test("extractAddress finds a base58 address anywhere", () => {
  assert.equal(extractAddress(POOL), POOL);
  assert.equal(extractAddress(`https://solscan.io/account/${POOL}?cluster=x`), POOL);
  assert.equal(extractAddress(`https://app.meteora.ag/dlmm/${POOL}`), POOL);
  assert.equal(extractAddress(`ca: ${POOL} thanks`), POOL);
});

test("extractAddress returns null when there is none", () => {
  assert.equal(extractAddress("hello"), null);
  assert.equal(extractAddress("20"), null);
  assert.equal(extractAddress(""), null);
  assert.equal(extractAddress(null), null);
  // Lebih panjang dari 44 (mis. private key / signature) bukan alamat.
  assert.equal(extractAddress(POOL + POOL), null);
});
