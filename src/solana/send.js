import bs58 from "bs58";
import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { sleep } from "../core/utils.js";
import { pickTipAccount, sendBundle } from "./jito.js";

function signatureOf(tx) {
  const sig = tx.signatures?.[0];
  if (!sig) return null;
  const bytes = sig.signature ? sig.signature : sig;
  return bs58.encode(Buffer.from(bytes));
}

// Sisipkan instruksi fee ke transaksi (sekali saja, sebelum loop kirim ulang).
// ComputeBudget ditaruh di depan; transfer tip Jito di belakang.
function attachFeeInstructions(tx, plan, wallet) {
  if (!plan || plan.mode === "none") return;

  if (plan.priorityMicroLamports > 0) {
    const instructions = [];
    if (plan.computeUnitLimit > 0) {
      instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnitLimit }));
    }
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: plan.priorityMicroLamports }));
    tx.instructions.unshift(...instructions);
  }

  if (plan.jitoTipLamports > 0 && !plan.jitoTipAccount) {
    const account = pickTipAccount(config.entry.fees.jitoTipAccounts);
    if (!account) throw new Error("Jito tip account tidak tersedia");
    plan.jitoTipAccount = account;
    tx.instructions.push(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(account),
        lamports: plan.jitoTipLamports,
      })
    );
  }
}

/**
 * Kirim + konfirmasi transaksi dengan ketahanan terhadap blockhash kedaluwarsa.
 *
 * - Ambil blockhash + lastValidBlockHeight.
 * - Mode priority/both: sisipkan ComputeBudget.
 * - Mode jito/both: kirim sebagai bundle ke Jito (plus RPC bila dualSend).
 * - Kirim ulang berkala; bila blockhash habis, ambil blockhash baru, tanda
 *   tangan ulang, lalu kirim lagi (tidak langsung menyerah).
 *
 * `tx` harus berupa Transaction legacy (hasil SDK Meteora).
 * Mengembalikan { signature, mode, feePlan, attempts }.
 */
export async function sendAndConfirmRobust({ connection, tx, signers, feePlan, wallet }) {
  const fees = config.entry.fees;
  const feePayer = wallet || (signers && signers[0]);
  if (!feePayer) throw new Error("sendAndConfirmRobust: wallet/signer tidak ada");
  if (!tx.feePayer) tx.feePayer = feePayer.publicKey;

  const plan = feePlan || { mode: "none" };
  attachFeeInstructions(tx, plan, feePayer);

  const useJito = plan.mode === "jito" || plan.mode === "both";
  const useDual = fees.dualSend;
  const deadline = Date.now() + fees.confirmTimeoutSec * 1000;
  let lastResult = null;

  for (let attempt = 1; attempt <= fees.retryAttempts; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.sign(...signers);
    const raw = tx.serialize();
    const signature = signatureOf(tx);

    if (attempt > 1) {
      log.info(`Entry tx retry ${attempt}/${fees.retryAttempts} — blockhash baru ${blockhash.slice(0, 8)}`);
    }

    let lastSendAt = 0;
    let expired = false;

    while (Date.now() < deadline) {
      if (Date.now() - lastSendAt >= fees.resendIntervalMs) {
        lastSendAt = Date.now();
        if (useJito) {
          try {
            await sendBundle([raw.toString("base64")]);
          } catch (err) {
            log.warn(`Jito sendBundle gagal: ${err.message}`);
          }
        }
        if (!useJito || useDual) {
          try {
            await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
          } catch (err) {
            // "already processed"/duplikat wajar saat resend — abaikan.
            log.debug(`[detail] sendRawTransaction: ${err.message}`);
          }
        }
      }

      let status = null;
      try {
        const res = await connection.getSignatureStatuses([signature]);
        status = res?.value?.[0] || null;
      } catch (err) {
        log.debug(`[detail] getSignatureStatuses gagal: ${err.message}`);
      }

      if (status) {
        if (status.err) {
          const e = new Error(`Tx gagal on-chain: ${JSON.stringify(status.err)}`);
          e.signature = signature;
          throw e;
        }
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          return { signature, mode: plan.mode, feePlan: plan, attempts: attempt };
        }
      }

      let blockHeight = null;
      try {
        blockHeight = await connection.getBlockHeight("confirmed");
      } catch {
        blockHeight = null;
      }
      if (blockHeight != null && blockHeight > lastValidBlockHeight) {
        // Cek sekali lagi dengan riwayat penuh: mungkin tx sudah mendarat
        // walau status sebelumnya belum terlihat.
        try {
          const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
          const finalStatus = res?.value?.[0];
          if (finalStatus?.err) {
            const e = new Error(`Tx gagal on-chain: ${JSON.stringify(finalStatus.err)}`);
            e.signature = signature;
            throw e;
          }
          if (finalStatus) {
            return { signature, mode: plan.mode, feePlan: plan, attempts: attempt };
          }
        } catch (err) {
          if (err.signature) throw err;
        }
        expired = true;
        break;
      }

      await sleep(Math.min(1000, fees.resendIntervalMs));
    }

    lastResult = { signature, expired };
    if (Date.now() >= deadline) break;
  }

  const e = new Error(
    `Tx tidak terkonfirmasi setelah ${fees.retryAttempts} percobaan${lastResult?.expired ? " (blockhash expired)" : ""}`
  );
  if (lastResult?.signature) e.signature = lastResult.signature;
  throw e;
}
