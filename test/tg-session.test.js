import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { put, get, take, del, issueToken, redeemToken, TTL_MS } from "../src/tg/session.js";

test("TTL is 10 minutes", () => {
  assert.equal(TTL_MS, 600000);
});

test("token is one-shot", () => {
  const t = issueToken({ a: 1 });
  assert.match(t, /^[0-9a-z]{8}$/);
  assert.deepEqual(redeemToken(t), { a: 1 });
  assert.equal(redeemToken(t), null);
});

test("token expires", async () => {
  const t = issueToken({ a: 1 }, 1);
  await sleep(5);
  assert.equal(redeemToken(t), null);
});

test("put/get expiry", async () => {
  put("k1", "v");
  assert.equal(get("k1"), "v");
  put("k2", "v", 1);
  await sleep(5);
  assert.equal(get("k2"), null);
  assert.equal(get("missing"), null);
});

test("take deletes", () => {
  put("k3", { x: 1 });
  assert.deepEqual(take("k3"), { x: 1 });
  assert.equal(get("k3"), null);
  put("k4", 1);
  del("k4");
  assert.equal(get("k4"), null);
});
