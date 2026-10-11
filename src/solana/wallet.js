import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import config from "../config/index.js";

let _wallet = null;

export function getWallet() {
  if (!_wallet) {
    if (!config.walletPrivateKey) {
      throw new Error("WALLET_PRIVATE_KEY is not set");
    }
    let decoded;
    try {
      decoded = bs58.decode(config.walletPrivateKey);
    } catch {
      decoded = JSON.parse(config.walletPrivateKey);
    }
    _wallet = Keypair.fromSecretKey(decoded.length === 64 ? decoded : Uint8Array.from(decoded));
  }
  return _wallet;
}
