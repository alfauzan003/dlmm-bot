import test from "node:test";
import assert from "node:assert/strict";
import { selectWatchCandidates } from "../src/entry/candidates.js";

const c = (pool, mint = `m-${pool}`) => ({ pool, mint });

test("kandidat normal lolos", () => {
  const out = selectWatchCandidates([c("p1"), c("p2")], {});
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p1", "p2"]
  );
});

test("pool in-flight disaring", () => {
  const out = selectWatchCandidates([c("p1"), c("p2")], { inFlight: new Set(["p1"]) });
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p2"]
  );
});

test("pool yang sudah entry (entered) disaring", () => {
  const out = selectWatchCandidates([c("p1"), c("p2")], { entered: new Map([["p1", 0]]) });
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p2"]
  );
});

test("cooldown aktif disaring, yang sudah lewat lolos", () => {
  const out = selectWatchCandidates([c("p1"), c("p2")], {
    cooldowns: new Map([
      ["p1", 2000],
      ["p2", 500],
    ]),
    now: 1000,
  });
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p2"]
  );
});

test("kandidat gabungan (in-flight + entered + cooldown) menyisakan satu", () => {
  const out = selectWatchCandidates([c("p1"), c("p2"), c("p3"), c("p4")], {
    inFlight: new Set(["p1"]),
    entered: new Map([["p2", 0]]),
    cooldowns: new Map([["p3", 9999]]),
    now: 1000,
  });
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p4"]
  );
});

test("entri tanpa pool/mint dibuang", () => {
  const out = selectWatchCandidates([{ pool: "p1" }, { mint: "m2" }, null, c("p3")], {});
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p3"]
  );
});
