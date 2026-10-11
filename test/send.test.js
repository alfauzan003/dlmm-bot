import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import config from "../src/config/index.js";
import { sendAndConfirmRobust } from "../src/solana/send.js";

const BLOCKHASH = "11111111111111111111111111111111";

function withFees(overrides, fn) {
  const original = { ...config.entry.fees };
  Object.assign(config.entry.fees, overrides);
  try {
    return fn();
  } finally {
    Object.assign(config.entry.fees, original);
  }
}

function makeTx(wallet, newPosition) {
  const tx = new Transaction()
    .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: newPosition.publicKey, lamports: 1 }))
    .add(SystemProgram.transfer({ fromPubkey: newPosition.publicKey, toPubkey: wallet.publicKey, lamports: 1 }));
  tx.feePayer = wallet.publicKey;
  return tx;
}

function baseFees() {
  return { resendIntervalMs: 1, confirmTimeoutSec: 3, retryAttempts: 2, dualSend: false, maxSol: 0 };
}

function tipTransferLamports(tx) {
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 12) continue;
    const lamports = Number(data.readBigUInt64LE(4));
    if (lamports === 1_000_000) return lamports;
  }
  return 0;
}

test("mode priority menyisipkan ComputeBudget dan konfirmasi", async () => {
  await withFees(baseFees(), async () => {
    const wallet = Keypair.generate();
    const newPosition = Keypair.generate();
    const tx = makeTx(wallet, newPosition);
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
      sendRawTransaction: async () => "sig",
      getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }),
      getBlockHeight: async () => 1,
    };
    const feePlan = { mode: "priority", priorityMicroLamports: 50000, computeUnitLimit: 0, jitoTipLamports: 0 };

    const res = await sendAndConfirmRobust({ connection, tx, signers: [wallet, newPosition], feePlan, wallet });
    assert.equal(res.mode, "priority");
    assert.ok(res.signature);
    assert.ok(tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId)));
  });
});

test("mode jito menambah transfer tip dan memakai sendBundle", async () => {
  const originalFetch = globalThis.fetch;
  let bundlePayload = null;
  globalThis.fetch = async (_url, opts) => {
    bundlePayload = JSON.parse(opts.body);
    return { json: async () => ({ result: "bundle-1" }) };
  };
  try {
    await withFees({ ...baseFees(), retryAttempts: 1 }, async () => {
      const wallet = Keypair.generate();
      const newPosition = Keypair.generate();
      const tx = makeTx(wallet, newPosition);
      const connection = {
        getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
        sendRawTransaction: async () => "sig",
        getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }),
        getBlockHeight: async () => 1,
      };
      const feePlan = { mode: "jito", priorityMicroLamports: 0, computeUnitLimit: 0, jitoTipLamports: 1_000_000 };

      const res = await sendAndConfirmRobust({ connection, tx, signers: [wallet, newPosition], feePlan, wallet });
      assert.equal(res.mode, "jito");
      assert.equal(tipTransferLamports(tx), 1_000_000);
      assert.equal(bundlePayload.method, "sendBundle");
      assert.equal(bundlePayload.params[0].length, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("blockhash expired memicu percobaan ulang dengan blockhash baru", async () => {
  await withFees(baseFees(), async () => {
    const wallet = Keypair.generate();
    const newPosition = Keypair.generate();
    const tx = makeTx(wallet, newPosition);
    let blockhashCalls = 0;
    let statusCalls = 0;
    const connection = {
      getLatestBlockhash: async () => {
        blockhashCalls++;
        return { blockhash: BLOCKHASH, lastValidBlockHeight: blockhashCalls === 1 ? 1000 : 3000 };
      },
      sendRawTransaction: async () => "sig",
      getSignatureStatuses: async () => {
        statusCalls++;
        // panggilan 1: cek rutin (null), panggilan 2: cek riwayat saat expired (null),
        // panggilan 3: percobaan kedua -> terkonfirmasi.
        if (statusCalls <= 2) return { value: [null] };
        return { value: [{ confirmationStatus: "confirmed", err: null }] };
      },
      getBlockHeight: async () => 2000,
    };
    const feePlan = { mode: "none", priorityMicroLamports: 0, computeUnitLimit: 0, jitoTipLamports: 0 };

    const res = await sendAndConfirmRobust({ connection, tx, signers: [wallet, newPosition], feePlan, wallet });
    assert.equal(res.attempts, 2);
    assert.equal(blockhashCalls, 2);
  });
});

test("error on-chain melempar dengan signature", async () => {
  await withFees(baseFees(), async () => {
    const wallet = Keypair.generate();
    const newPosition = Keypair.generate();
    const tx = makeTx(wallet, newPosition);
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
      sendRawTransaction: async () => "sig",
      getSignatureStatuses: async () => ({
        value: [{ confirmationStatus: "processed", err: { InstructionError: [0, "Custom"] } }],
      }),
      getBlockHeight: async () => 1,
    };
    const feePlan = { mode: "none", priorityMicroLamports: 0, computeUnitLimit: 0, jitoTipLamports: 0 };

    await assert.rejects(
      () => sendAndConfirmRobust({ connection, tx, signers: [wallet, newPosition], feePlan, wallet }),
      (err) => {
        assert.match(err.message, /gagal on-chain/);
        assert.ok(err.signature);
        return true;
      }
    );
  });
});

test("blockhash expired tapi terdeteksi mendarat di cek riwayat -> sukses", async () => {
  await withFees(baseFees(), async () => {
    const wallet = Keypair.generate();
    const newPosition = Keypair.generate();
    const tx = makeTx(wallet, newPosition);
    let statusCalls = 0;
    let blockhashCalls = 0;
    const connection = {
      getLatestBlockhash: async () => {
        blockhashCalls++;
        return { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 };
      },
      sendRawTransaction: async () => "sig",
      getSignatureStatuses: async () => {
        statusCalls++;
        if (statusCalls === 1) return { value: [null] };
        return { value: [{ confirmationStatus: "processed", err: null }] };
      },
      getBlockHeight: async () => 5000,
    };
    const feePlan = { mode: "none", priorityMicroLamports: 0, computeUnitLimit: 0, jitoTipLamports: 0 };

    const res = await sendAndConfirmRobust({ connection, tx, signers: [wallet, newPosition], feePlan, wallet });
    assert.equal(res.attempts, 1);
    assert.equal(blockhashCalls, 1);
  });
});
