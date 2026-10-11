import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import config from "../config/index.js";
import { getConnection } from "./connection.js";
import { getWallet } from "./wallet.js";
import { buildFeePlan } from "./fees.js";
import { sendAndConfirmRobust } from "./send.js";

const LAMPORTS_PER_SOL = 1e9;
// Sisa SOL yang selalu ditinggalkan di wallet (biaya tx + rent akun).
export const WITHDRAW_RESERVE_SOL = 0.01;

export function maxWithdrawSol(balanceSol) {
  return Math.max(0, balanceSol - WITHDRAW_RESERVE_SOL);
}

// Dependensi yang bisa diganti tes.
const DEFAULT_DEPS = {
  getConnection,
  getWallet,
  buildFeePlan,
  sendAndConfirmRobust,
  isDryRun: () => config.dryRun,
};

const firstLine = (err) => String(err?.message ?? err).split("\n")[0];

export async function withdrawSol({ to, amountSol, deps = {} }) {
  const d = { ...DEFAULT_DEPS, ...deps };
  let toKey;
  try {
    toKey = new PublicKey(String(to ?? "").trim());
  } catch {
    return { success: false, error: "Invalid destination address" };
  }
  const lamports = Math.round(Number(amountSol) * LAMPORTS_PER_SOL);
  if (!Number.isFinite(lamports) || lamports <= 0) {
    return { success: false, error: "Invalid amount" };
  }
  if (d.isDryRun()) return { success: true, dryRun: true };

  try {
    const connection = d.getConnection();
    const wallet = d.getWallet();
    // Saldo bisa berubah sejak layar konfirmasi: cek ulang sebelum kirim.
    const balanceSol = (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
    if (amountSol > maxWithdrawSol(balanceSol) + 1e-9) {
      return { success: false, error: `Amount exceeds withdrawable balance (${maxWithdrawSol(balanceSol)} SOL)` };
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: toKey, lamports })
    );
    const res = await d.sendAndConfirmRobust({
      connection,
      tx,
      signers: [wallet],
      feePlan: d.buildFeePlan(),
      wallet,
    });
    return { success: true, tx: res.signature };
  } catch (err) {
    return { success: false, error: firstLine(err) };
  }
}
