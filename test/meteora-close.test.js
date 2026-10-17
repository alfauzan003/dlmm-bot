import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair } from "@solana/web3.js";

// Arahkan file state ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-meteoraclose-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { default: config } = await import("../src/config/index.js");
const { closePosition } = await import("../src/meteora/close.js");

const WSOL = "So11111111111111111111111111111111111111112";
const POSITION = Keypair.generate().publicKey;
const POOL = Keypair.generate().publicKey.toString();
const MINT = Keypair.generate().publicKey.toString();

function fakeDeps({ hasLiquidity = true, feeCapOk = true } = {}) {
  const wallet = Keypair.generate();
  const calls = { sends: [], removeLiquidity: 0, closePosition: 0, claim: 0, scans: 0, accountChecks: 0 };
  let lookups = 0;
  const pool = {
    lbPair: { tokenXMint: MINT, tokenYMint: WSOL },
    getPositionsByUserAndLbPair: async () => ({ userPositions: [{ publicKey: POSITION }] }),
    claimSwapFee: async () => {
      calls.claim++;
      return [{ kind: "claim" }];
    },
    getPosition: async () => ({
      positionData: {
        lowerBinId: 10,
        upperBinId: 20,
        positionBinData: [{ positionLiquidity: hasLiquidity ? "5" : "0" }],
      },
    }),
    removeLiquidity: async () => {
      calls.removeLiquidity++;
      return [{ kind: "remove-1" }, { kind: "remove-2" }];
    },
    closePosition: async () => {
      calls.closePosition++;
      return { kind: "close" };
    },
  };
  const DLMM = {
    // Lookup pertama: posisi ada; verifikasi setelah close: sudah hilang.
    getAllLbPairPositionsByUser: async () => {
      calls.scans++;
      return lookups++ === 0 ? new Map([[POOL, { lbPairPositionsData: [{ publicKey: POSITION }] }]]) : new Map();
    },
    create: async () => pool,
  };
  const deps = {
    // Akun posisi sudah terhapus setelah close.
    getConnection: () => ({
      getAccountInfo: async () => {
        calls.accountChecks++;
        return null;
      },
    }),
    getWallet: () => wallet,
    getDlmmSdk: async () => ({ DLMM }),
    getTokenBalance: async () => 42,
    buildFeePlan: () => ({
      mode: "both",
      priorityMicroLamports: 1000,
      computeUnitLimit: 400_000,
      jitoTipLamports: 1_000_000,
      jitoTipAccount: null,
    }),
    checkFeeCap: () => ({ ok: feeCapOk, totalSol: 0.5, cap: 0.01 }),
    sendAndConfirmRobust: async (args) => {
      calls.sends.push(args);
      return { signature: `sig-${args.tx.kind}` };
    },
    sleep: async () => {},
  };
  return { deps, calls, wallet };
}

async function withLive(fn) {
  const saved = config.dryRun;
  config.dryRun = false;
  try {
    return await fn();
  } finally {
    config.dryRun = saved;
  }
}

test("close (claim di dalam tx removeLiquidity) dikirim lewat sendAndConfirmRobust dengan fee plan baru per tx", async () => {
  await withLive(async () => {
    const { deps, calls, wallet } = fakeDeps();
    const res = await closePosition(POSITION.toString(), { deps });

    assert.equal(res.success, true);
    assert.equal(res.claimTx, null);
    assert.deepEqual(res.txs, ["sig-remove-1", "sig-remove-2"]);
    assert.equal(res.baseMint, MINT);
    assert.equal(res.baseAmount, 42);

    assert.deepEqual(
      calls.sends.map((s) => s.tx.kind),
      ["remove-1", "remove-2"]
    );
    // Posisi berlikuiditas: tidak ada tx claim terpisah (shouldClaimAndClose sudah claim).
    assert.equal(calls.claim, 0);
    for (const s of calls.sends) {
      assert.equal(s.wallet, wallet);
      assert.deepEqual(s.signers, [wallet]);
      assert.equal(s.feePlan.mode, "both");
      assert.equal(s.feePlan.priorityMicroLamports, 1000);
      assert.equal(s.feePlan.jitoTipLamports, 1_000_000);
      // Tx SDK sudah membawa setComputeUnitLimit sendiri.
      assert.equal(s.feePlan.computeUnitLimit, 0);
    }
    // Objek rencana terpisah per tx (tip Jito dipasang per tx).
    assert.equal(new Set(calls.sends.map((s) => s.feePlan)).size, calls.sends.length);
  });
});

test("posisi tanpa likuiditas ditutup via pool.closePosition lewat jalur robust", async () => {
  await withLive(async () => {
    const { deps, calls } = fakeDeps({ hasLiquidity: false });
    const res = await closePosition(POSITION.toString(), { deps });

    assert.equal(res.success, true);
    assert.deepEqual(res.txs, ["sig-close"]);
    assert.equal(calls.removeLiquidity, 0);
    assert.equal(calls.closePosition, 1);
    assert.deepEqual(
      calls.sends.map((s) => s.tx.kind),
      ["claim", "close"]
    );
  });
});

test("fee cap terlampaui tidak membatalkan close", async () => {
  await withLive(async () => {
    const { deps, calls } = fakeDeps({ feeCapOk: false });
    const res = await closePosition(POSITION.toString(), { deps });

    assert.equal(res.success, true);
    assert.deepEqual(res.txs, ["sig-remove-1", "sig-remove-2"]);
    assert.equal(calls.sends.length, 2);
  });
});

test("close gagal kirim dicoba ulang dengan tx dibangun ulang", async () => {
  await withLive(async () => {
    const { deps, calls } = fakeDeps({ hasLiquidity: false });
    const send = deps.sendAndConfirmRobust;
    let closeFails = 1;
    deps.sendAndConfirmRobust = async (args) => {
      if (args.tx.kind === "close" && closeFails-- > 0) throw new Error("Tx tidak terkonfirmasi");
      return send(args);
    };
    const res = await closePosition(POSITION.toString(), { deps });

    assert.equal(res.success, true);
    assert.deepEqual(res.txs, ["sig-close"]);
    assert.equal(calls.closePosition, 2);
  });
});

test("pool diketahui: tanpa scan wallet; verifikasi lewat getAccountInfo", async () => {
  await withLive(async () => {
    const { deps, calls } = fakeDeps();
    const res = await closePosition(POSITION.toString(), { poolAddress: POOL, deps });

    assert.equal(res.success, true);
    assert.equal(res.pool, POOL);
    assert.equal(calls.scans, 0);
    assert.equal(calls.accountChecks, 1);
  });
});

test("pool tidak diketahui: scan wallet sekali saja (bukan untuk verifikasi)", async () => {
  await withLive(async () => {
    const { deps, calls } = fakeDeps();
    const res = await closePosition(POSITION.toString(), { deps });

    assert.equal(res.success, true);
    assert.equal(res.pool, POOL);
    assert.equal(calls.scans, 1);
  });
});

test("DRY_RUN tidak mengirim apa pun", async () => {
  const saved = config.dryRun;
  config.dryRun = true;
  try {
    const { deps, calls } = fakeDeps();
    const res = await closePosition(POSITION.toString(), { deps });
    assert.deepEqual(res, { success: true, dryRun: true });
    assert.equal(calls.sends.length, 0);
  } finally {
    config.dryRun = saved;
  }
});
