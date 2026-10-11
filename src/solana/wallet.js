import fs from "fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import config from "../config/index.js";
import { WALLET_KEY_FILE } from "../core/paths.js";

let _wallet = null;

// File kunci (wallet.key) menang atas WALLET_PRIVATE_KEY di .env. Kosong/tidak ada → null.
function readKeyFile() {
  try {
    return fs.readFileSync(WALLET_KEY_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Base58 atau array JSON, harus 64 byte dan valid. Tidak valid → null (tanpa mengutip input di error).
export function parseSecretKey(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  let bytes = null;
  try {
    bytes = bs58.decode(raw);
  } catch {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        bytes = Uint8Array.from(arr);
      }
    } catch {
      bytes = null;
    }
  }
  if (!bytes || bytes.length !== 64) return null;
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    return null;
  }
}

// Ada sumber wallet (wallet.key atau .env)?
export function hasWalletKey() {
  return Boolean(readKeyFile() || config.walletPrivateKey);
}

export function getWallet() {
  if (!_wallet) {
    const fromFile = readKeyFile();
    const raw = fromFile || config.walletPrivateKey;
    if (!raw) {
      throw new Error("WALLET_PRIVATE_KEY is not set");
    }
    const keypair = parseSecretKey(raw);
    if (!keypair) {
      throw new Error(`${fromFile ? "wallet.key" : "WALLET_PRIVATE_KEY"} is not a valid key`);
    }
    _wallet = keypair;
  }
  return _wallet;
}

// Buang cache supaya getWallet() membaca ulang sumber kunci.
export function reloadWallet() {
  _wallet = null;
}

// Tulis kunci (base58) ke wallet.key lewat file sementara lalu rename; chmod 0o600 best-effort.
export function saveWalletKey(keypair) {
  const tmp = `${WALLET_KEY_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, bs58.encode(keypair.secretKey), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, WALLET_KEY_FILE);
  } catch {
    // File sementara memuat kunci: hapus. Error asli tidak diteruskan (tidak boleh membawa isi kunci).
    fs.rmSync(tmp, { force: true });
    throw new Error("Couldn't save wallet.key");
  }
  try {
    fs.chmodSync(WALLET_KEY_FILE, 0o600);
  } catch {
    // Windows / filesystem tanpa mode: abaikan
  }
}

// Kunci rahasia aktif (base58). Tidak pernah di-cache atau dilog oleh pemanggil.
export function exportSecretKey() {
  return bs58.encode(getWallet().secretKey);
}
