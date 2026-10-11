import test from "node:test";
import assert from "node:assert/strict";
import {
  addEntryInProgressMint,
  removeEntryInProgressMint,
  getEntryInProgressMints,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  getEntryInProgressPools,
  isEntryInProgressPool,
} from "../src/entry/runtime.js";

test("in-progress pools are refcounted: two adds need two removes", () => {
  addEntryInProgressPool("PoolR");
  addEntryInProgressPool("PoolR");
  removeEntryInProgressPool("PoolR");
  assert.equal(isEntryInProgressPool("PoolR"), true);
  assert.equal(getEntryInProgressPools().has("PoolR"), true);
  removeEntryInProgressPool("PoolR");
  assert.equal(isEntryInProgressPool("PoolR"), false);
  assert.equal(getEntryInProgressPools().size, 0);
  // Remove berlebih tidak membuat hitungan negatif.
  removeEntryInProgressPool("PoolR");
  addEntryInProgressPool("PoolR");
  assert.deepEqual([...getEntryInProgressPools()], ["PoolR"]);
  removeEntryInProgressPool("PoolR");
  assert.equal(isEntryInProgressPool("PoolR"), false);
});

test("in-progress mints are refcounted, also through the shared set object", () => {
  addEntryInProgressMint("MintR");
  getEntryInProgressMints().add("MintR"); // entry/index.js memakai Set bersama secara langsung
  removeEntryInProgressMint("MintR");
  assert.equal(getEntryInProgressMints().has("MintR"), true);
  getEntryInProgressMints().delete("MintR");
  assert.equal(getEntryInProgressMints().has("MintR"), false);
});
