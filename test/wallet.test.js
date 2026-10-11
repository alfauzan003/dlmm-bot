import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// File kunci diarahkan ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-wallet-"));
process.env.WALLET_KEY_FILE = path.join(TMP, "wallet.key");

const walletModule = await import("../src/solana/wallet.js");
const { getWallet, reloadWallet, parseSecretKey, saveWalletKey, exportSecretKey, hasWalletKey } = walletModule;
const { withdrawSol, maxWithdrawSol } = await import("../src/solana/transfer.js");
const { default: config } = await import("../src/config/index.js");

const KEY_FILE = process.env.WALLET_KEY_FILE;
const ORIGINAL_ENV_KEY = config.walletPrivateKey;

test.beforeEach(() => {
  fs.rmSync(KEY_FILE, { force: true });
  config.walletPrivateKey = ORIGINAL_ENV_KEY;
  reloadWallet();
});

test.after(() => {
  config.walletPrivateKey = ORIGINAL_ENV_KEY;
  reloadWallet();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("key file wins over env", () => {
  const fromEnv = Keypair.generate();
  const fromFile = Keypair.generate();
  config.walletPrivateKey = bs58.encode(fromEnv.secretKey);
  assert.equal(getWallet().publicKey.toBase58(), fromEnv.publicKey.toBase58());
  reloadWallet();
  fs.writeFileSync(KEY_FILE, `${bs58.encode(fromFile.secretKey)}\n`);
  assert.equal(getWallet().publicKey.toBase58(), fromFile.publicKey.toBase58());
});

test("empty key file falls back to env", () => {
  const fromEnv = Keypair.generate();
  config.walletPrivateKey = JSON.stringify(Array.from(fromEnv.secretKey));
  fs.writeFileSync(KEY_FILE, "  \n");
  assert.equal(getWallet().publicKey.toBase58(), fromEnv.publicKey.toBase58());
});

test("hasWalletKey accepts either source", () => {
  config.walletPrivateKey = "";
  assert.equal(hasWalletKey(), false);
  fs.writeFileSync(KEY_FILE, bs58.encode(Keypair.generate().secretKey));
  assert.equal(hasWalletKey(), true);
  fs.rmSync(KEY_FILE);
  config.walletPrivateKey = bs58.encode(Keypair.generate().secretKey);
  assert.equal(hasWalletKey(), true);
});

test("reloadWallet picks up a new key", () => {
  const first = Keypair.generate();
  const second = Keypair.generate();
  saveWalletKey(first);
  assert.equal(getWallet().publicKey.toBase58(), first.publicKey.toBase58());
  saveWalletKey(second);
  assert.equal(getWallet().publicKey.toBase58(), first.publicKey.toBase58()); // masih cache
  reloadWallet();
  assert.equal(getWallet().publicKey.toBase58(), second.publicKey.toBase58());
});

test("saveWalletKey writes base58 and exportSecretKey returns it", () => {
  const kp = Keypair.generate();
  saveWalletKey(kp);
  assert.equal(fs.readFileSync(KEY_FILE, "utf8").trim(), bs58.encode(kp.secretKey));
  assert.equal(exportSecretKey(), bs58.encode(kp.secretKey));
  assert.ok(!fs.existsSync(`${KEY_FILE}.tmp`));
  if (process.platform !== "win32") assert.equal(fs.statSync(KEY_FILE).mode & 0o777, 0o600);
});

test("parseSecretKey accepts base58 and JSON array", () => {
  const kp = Keypair.generate();
  assert.equal(parseSecretKey(bs58.encode(kp.secretKey)).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(parseSecretKey(`  ${bs58.encode(kp.secretKey)}\n`).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(parseSecretKey(JSON.stringify(Array.from(kp.secretKey))).publicKey.toBase58(), kp.publicKey.toBase58());
});

test("parseSecretKey rejects 32-byte keys, mismatched pairs and garbage", () => {
  const kp = Keypair.generate();
  assert.equal(parseSecretKey(bs58.encode(kp.secretKey.slice(0, 32))), null);
  assert.equal(parseSecretKey(JSON.stringify(Array.from(kp.secretKey.slice(0, 32)))), null);
  assert.equal(parseSecretKey(kp.publicKey.toBase58()), null);
  const bad = Uint8Array.from(kp.secretKey);
  bad[40] ^= 0xff; // public half tidak cocok dengan seed
  assert.equal(parseSecretKey(bs58.encode(bad)), null);
  for (const junk of ["", "   ", "hello world", "[1,2,3]", '["a"]', "{}", "0OIl", null, undefined]) {
    assert.equal(parseSecretKey(junk), null, String(junk));
  }
});

test("an invalid key file throws without echoing its content", () => {
  fs.writeFileSync(KEY_FILE, "SECRET-LOOKING-GARBAGE");
  assert.throws(
    () => getWallet(),
    (err) => !err.message.includes("SECRET-LOOKING-GARBAGE")
  );
});

test("maxWithdrawSol keeps 0.01 SOL", () => {
  assert.equal(maxWithdrawSol(1), 0.99);
  assert.equal(maxWithdrawSol(0.005), 0);
});

function fakeDeps({ dryRun = false, balanceSol = 2 } = {}) {
  const sent = [];
  const wallet = Keypair.generate();
  return {
    sent,
    deps: {
      isDryRun: () => dryRun,
      getWallet: () => wallet,
      getConnection: () => ({ getBalance: async () => Math.round(balanceSol * 1e9) }),
      buildFeePlan: () => ({ mode: "none" }),
      sendAndConfirmRobust: async (args) => {
        sent.push(args);
        return { signature: "SIG123" };
      },
    },
  };
}

test("withdraw rejects a bad address without sending", async () => {
  const { sent, deps } = fakeDeps();
  for (const to of ["", "not-an-address", "123"]) {
    const res = await withdrawSol({ to, amountSol: 0.1, deps });
    assert.equal(res.success, false, to);
  }
  assert.equal(sent.length, 0);
});

test("withdraw rejects non-positive amounts without sending", async () => {
  const { sent, deps } = fakeDeps();
  const to = Keypair.generate().publicKey.toBase58();
  for (const amountSol of [0, -1, NaN, 1e-12]) {
    assert.equal((await withdrawSol({ to, amountSol, deps })).success, false, String(amountSol));
  }
  assert.equal(sent.length, 0);
});

test("withdraw dry run sends nothing", async () => {
  const { sent, deps } = fakeDeps({ dryRun: true });
  const res = await withdrawSol({ to: Keypair.generate().publicKey.toBase58(), amountSol: 0.1, deps });
  assert.deepEqual(res, { success: true, dryRun: true });
  assert.equal(sent.length, 0);
});

test("withdraw sends a SystemProgram transfer for the exact lamports", async () => {
  const { sent, deps } = fakeDeps();
  const to = Keypair.generate().publicKey;
  const res = await withdrawSol({ to: to.toBase58(), amountSol: 0.25, deps });
  assert.deepEqual(res, { success: true, tx: "SIG123" });
  assert.equal(sent.length, 1);
  const ix = sent[0].tx.instructions[0];
  assert.equal(ix.keys[1].pubkey.toBase58(), to.toBase58());
  assert.equal(Number(ix.data.readBigUInt64LE(4)), 250_000_000);
});

test("withdraw re-checks the live balance", async () => {
  const { sent, deps } = fakeDeps({ balanceSol: 0.5 });
  const res = await withdrawSol({ to: Keypair.generate().publicKey.toBase58(), amountSol: 0.5, deps });
  assert.equal(res.success, false);
  assert.equal(sent.length, 0);
});

test("withdraw reports send failures", async () => {
  const { deps } = fakeDeps();
  deps.sendAndConfirmRobust = async () => {
    throw new Error("boom\nsecond line");
  };
  const res = await withdrawSol({ to: Keypair.generate().publicKey.toBase58(), amountSol: 0.1, deps });
  assert.deepEqual(res, { success: false, error: "boom" });
});

test("saveWalletKey removes the temp file and hides the key when the rename fails", () => {
  const kp = Keypair.generate();
  const secret = bs58.encode(kp.secretKey);
  fs.mkdirSync(KEY_FILE); // rename naar sebuah direktori selalu gagal
  try {
    assert.throws(
      () => saveWalletKey(kp),
      (err) => err.message === "Couldn't save wallet.key" && !String(err.stack).includes(secret)
    );
    assert.ok(!fs.existsSync(`${KEY_FILE}.tmp`));
  } finally {
    fs.rmdirSync(KEY_FILE);
  }
});
