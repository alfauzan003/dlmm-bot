import test from "node:test";
import assert from "node:assert/strict";
import { createGmgnLimiter } from "../src/market/gmgn-limiter.js";

test("limiter preserves order and enforces min gap", async () => {
  const limiter = createGmgnLimiter({ maxPerMin: 100, minGapMs: 50 });
  const order = [];
  const t0 = Date.now();
  await Promise.all(
    [1, 2, 3].map((n) =>
      limiter.schedule(null, async () => {
        order.push(n);
      })
    )
  );
  const elapsed = Date.now() - t0;
  assert.deepEqual(order, [1, 2, 3]);
  assert.ok(elapsed >= 80, `elapsed ${elapsed}ms should be >= ~100ms`);
});

test("limiter dedups concurrent tasks with the same key", async () => {
  const limiter = createGmgnLimiter({ maxPerMin: 100, minGapMs: 0 });
  let calls = 0;
  const fn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return 42;
  };
  const [a, b] = await Promise.all([limiter.schedule("k", fn), limiter.schedule("k", fn)]);
  assert.equal(calls, 1);
  assert.equal(a, 42);
  assert.equal(b, 42);
});

test("limiter enforces the per-minute cap", async () => {
  const limiter = createGmgnLimiter({ maxPerMin: 2, minGapMs: 0 });
  await Promise.all([limiter.schedule(null, async () => {}), limiter.schedule(null, async () => {})]);
  const wait = limiter.nextAllowedAt() - Date.now();
  assert.ok(wait > 50000, `wait ${wait}ms should be ~60s`);
});

test("blockFor pauses scheduling", async () => {
  const limiter = createGmgnLimiter({ maxPerMin: 100, minGapMs: 0 });
  limiter.blockFor(80);
  const t0 = Date.now();
  await limiter.schedule(null, async () => {});
  assert.ok(Date.now() - t0 >= 70);
});
