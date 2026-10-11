import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { PagedConnection } from "../src/solana/connection.js";

const PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const OWNER = Keypair.generate().publicKey.toBase58();
const FILTERS = [
  { memcmp: { offset: 0, bytes: "LgkNAEYaVX3" } },
  { memcmp: { offset: 40, bytes: OWNER } },
];

function accountEntry(data = "") {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    account: { lamports: 1, data: [data, "base64"], owner: PROGRAM, executable: false, rentEpoch: 0, space: 0 },
  };
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function withOldMethod(impl, fn) {
  const original = Connection.prototype.getProgramAccounts;
  Connection.prototype.getProgramAccounts = impl;
  try {
    return await fn();
  } finally {
    Connection.prototype.getProgramAccounts = original;
  }
}

test("getProgramAccounts memakai V2 ber-paginasi dan menggabungkan halaman", async () => {
  const calls = [];
  const pages = [
    { result: { accounts: [accountEntry("")], paginationKey: "next-key" } },
    { result: { accounts: [accountEntry("AQ==")], paginationKey: null } },
  ];
  await withFetch(
    async (_url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { json: async () => pages[calls.length - 1] };
    },
    async () => {
      const conn = new PagedConnection("http://127.0.0.1:8899");
      const accounts = await conn.getProgramAccounts(new PublicKey(PROGRAM), {
        filters: FILTERS,
        dataSlice: { offset: 0, length: 0 },
      });
      assert.equal(accounts.length, 2);
      assert.ok(accounts[0].pubkey instanceof PublicKey);
      assert.ok(Buffer.isBuffer(accounts[1].account.data));
      assert.equal(accounts[1].account.data.toString("base64"), "AQ==");
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "getProgramAccountsV2");
  assert.equal(calls[0].params[0], PROGRAM);
  assert.equal(calls[0].params[1].limit, 1000);
  assert.equal(calls[0].params[1].encoding, "base64");
  assert.deepEqual(calls[0].params[1].filters, FILTERS);
  assert.deepEqual(calls[0].params[1].dataSlice, { offset: 0, length: 0 });
  assert.equal(calls[0].params[1].paginationKey, undefined);
  assert.equal(calls[1].params[1].paginationKey, "next-key");
});

test("fallback ke metode lama saat V2 tidak didukung", async () => {
  await withOldMethod(
    async () => "FALLBACK",
    async () => {
      await withFetch(
        async () => ({ json: async () => ({ error: { code: -32601, message: "Method not found" } }) }),
        async () => {
          const conn = new PagedConnection("http://127.0.0.1:8899");
          const res = await conn.getProgramAccounts(new PublicKey(PROGRAM), { filters: FILTERS });
          assert.equal(res, "FALLBACK");
        }
      );
    }
  );
});

test("error V2 selain method-not-found dilempar, bukan fallback", async () => {
  await withFetch(
    async () => ({ json: async () => ({ error: { code: -32005, message: "Too many requests" } }) }),
    async () => {
      const conn = new PagedConnection("http://127.0.0.1:8899");
      await assert.rejects(
        () => conn.getProgramAccounts(new PublicKey(PROGRAM), { filters: FILTERS }),
        /Too many requests/
      );
    }
  );
});

test("tanpa filter langsung pakai metode lama", async () => {
  await withOldMethod(
    async () => "OLD",
    async () => {
      const conn = new PagedConnection("http://127.0.0.1:8899");
      const res = await conn.getProgramAccounts(new PublicKey(PROGRAM), { dataSlice: { offset: 0, length: 0 } });
      assert.equal(res, "OLD");
    }
  );
});
