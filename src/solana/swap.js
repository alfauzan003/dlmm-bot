import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { sleep } from "../core/utils.js";
import { WSOL_MINT, TOKEN_PROGRAM_ID } from "../core/constants.js";
import { getConnection } from "./connection.js";
import { getWallet } from "./wallet.js";
import { getMintDecimals, getTokenBalance, getTokenValueUsd } from "./balances.js";

const JUPITER_SWAP_V2 = "https://api.jup.ag/swap/v2";

function getJupiterApiKey() {
  return config.jupiterSwapApiKey || "";
}

/**
 * Execute a Jupiter Swap V2 order (order -> sign -> execute).
 */
async function jupiterSwap({ inputMint, outputMint, rawAmount }) {
  const wallet = getWallet();
  const apiKey = getJupiterApiKey();
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const orderParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(rawAmount),
    taker: wallet.publicKey.toString(),
  });
  // SWAP_USE_RTSE=true → biarkan Jupiter mengestimasi slippage (mode ultra).
  // Default → pakai nilai tetap SWAP_SLIPPAGE_BPS (mode manual).
  if (!config.swap.useRtse) orderParams.set("slippageBps", String(config.swap.slippageBps));

  const orderRes = await fetch(`${JUPITER_SWAP_V2}/order?${orderParams}`, { headers });
  if (!orderRes.ok) {
    const err = new Error(`V2 order failed: ${orderRes.status} ${await orderRes.text()}`);
    err.status = orderRes.status;
    if (orderRes.status === 429) err.rateLimited = true;
    throw err;
  }
  const order = await orderRes.json();
  if (order.errorCode || order.errorMessage) {
    throw new Error(`V2 order error: ${order.errorMessage || order.errorCode}`);
  }

  const { transaction: unsignedTx, requestId } = order;
  const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
  tx.sign([wallet]);
  const signedTx = Buffer.from(tx.serialize()).toString("base64");

  const execRes = await fetch(`${JUPITER_SWAP_V2}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ signedTransaction: signedTx, requestId }),
  });
  if (!execRes.ok) {
    const err = new Error(`V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    err.status = execRes.status;
    if (execRes.status === 429) err.rateLimited = true;
    throw err;
  }

  const execResult = await execRes.json();
  if (execResult.status === "Failed") {
    const detail = execResult.error || execResult.errorMessage || "";
    const onchainErr = new Error(`Swap failed on-chain: code=${execResult.code}${detail ? ` — ${detail}` : ""}`);
    onchainErr.code = execResult.code;
    onchainErr.signature = execResult.signature;
    onchainErr.detail = detail;
    throw onchainErr;
  }

  return execResult;
}

/**
 * Swap SOL -> base token (used for the token side of a double-sided entry).
 * Retries transient on-chain failures with a fresh quote (harga bergerak cepat
 * saat entry). Kalau /execute melaporkan gagal tapi saldo token naik, tx
 * dianggap mendarat. Returns { success, tx, amountOut }.
 */
export async function swapSolToToken(baseMint, solAmount) {
  if (!baseMint || !solAmount || solAmount <= 0) {
    return { success: false, error: "no SOL to swap" };
  }

  if (config.dryRun) {
    log.info(`[DRY RUN] Would swap ${solAmount} SOL → ${baseMint.slice(0, 8)}`);
    return { success: true, dryRun: true, amountOut: 0 };
  }

  const rawAmount = Math.floor(solAmount * 1e9);
  const maxAttempts = Math.max(1, Number(config.swap.retryAttempts ?? 3));
  const delays = [3000, 10000, 20000];
  const balanceBefore = await getTokenBalance(baseMint);

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await jupiterSwap({
        inputMint: WSOL_MINT,
        outputMint: baseMint,
        rawAmount,
      });
      const txid = result.signature;
      await sleep(2000);
      const balanceAfter = await getTokenBalance(baseMint);
      const amountOut = balanceAfter - balanceBefore;
      log.info(
        `Swapped ${solAmount} SOL → ${baseMint.slice(0, 8)} (delta ${amountOut}, balance ${balanceAfter}): tx ${txid?.slice(0, 16)}`
      );
      return { success: true, tx: txid, amountOut };
    } catch (err) {
      lastErr = err;
      const sigLabel = err.signature ? ` | tx ${String(err.signature).slice(0, 16)}` : "";
      log.warn(`swapSolToToken attempt ${attempt}/${maxAttempts} failed: ${err.message}${sigLabel}`);

      // Bisa jadi tx mendarat walau /execute melaporkan gagal — cek saldo dulu
      // supaya tidak membeli token dua kali saat retry.
      const balanceAfter = await getTokenBalance(baseMint);
      if (balanceAfter > balanceBefore) {
        log.info(
          `swapSolToToken: saldo ${baseMint.slice(0, 8)} naik ${balanceBefore} → ${balanceAfter} walau error — dianggap sukses`
        );
        return { success: true, tx: err.signature, amountOut: balanceAfter - balanceBefore, recovered: true };
      }

      if (attempt < maxAttempts) {
        await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
      }
    }
  }

  log.error(`swapSolToToken failed after ${maxAttempts} attempts: ${lastErr?.message}`);
  return {
    success: false,
    error: lastErr?.message || "swap failed",
    rateLimited: !!lastErr?.rateLimited,
    code: lastErr?.code,
    signature: lastErr?.signature,
  };
}

/**
 * Swap a token back to SOL with retries. Dust (<= DUST_USD_THRESHOLD) is treated as success.
 */
export async function swapToSol(baseMint, amount) {
  if (!baseMint || !amount || amount <= 0) {
    return { success: false, error: "no token to swap" };
  }

  if (config.dryRun) {
    log.info(`[DRY RUN] Would swap ${amount} of ${baseMint.slice(0, 8)} → SOL`);
    return { success: true, dryRun: true };
  }

  const maxAttempts = Math.max(1, Number(config.swap.retryAttempts ?? 3));
  const delays = [5000, 15000, 30000];
  const decimals = await getMintDecimals(baseMint);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await jupiterSwap({
        inputMint: baseMint,
        outputMint: WSOL_MINT,
        rawAmount: Math.floor(amount * Math.pow(10, decimals)),
      });
      const txid = result.signature;
      log.info(`Swapped ${amount} ${baseMint.slice(0, 8)} → SOL: tx ${txid?.slice(0, 16)}`);

      await sleep(2000);
      const remaining = await getTokenBalance(baseMint);
      if (remaining <= 0) {
        return { success: true, tx: txid };
      }
      const valueUsd = await getTokenValueUsd(baseMint, remaining);
      if (valueUsd != null && valueUsd <= config.swap.dustUsdThreshold) {
        log.info(
          `Remaining ${remaining} ${baseMint.slice(0, 8)} is dust ($${valueUsd.toFixed(3)}) — treated as success`
        );
        return { success: true, tx: txid, dust: true };
      }
      throw new Error(
        `post-swap verify: ${remaining} ${baseMint.slice(0, 8)} remaining (${valueUsd != null ? `$${valueUsd.toFixed(3)}` : "?value"})`
      );
    } catch (err) {
      log.warn(`swapToSol attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
        const fresh = await getTokenBalance(baseMint);
        if (fresh <= 0) break;
        amount = fresh;
      }
    }
  }

  log.error(`swapToSol failed after ${maxAttempts} attempts`);
  return { success: false, error: `failed after ${maxAttempts} attempts` };
}

export async function sweepToSol({ excludeMints = config.swap.excludeMints || [] } = {}) {
  const connection = getConnection();
  const wallet = getWallet();
  const exclude = new Set([WSOL_MINT, ...excludeMints]);

  try {
    const tokenProgramId = new PublicKey(TOKEN_PROGRAM_ID);
    const { value: tokenAccounts } = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: tokenProgramId,
    });

    let swapped = 0;
    let totalAmount = 0;
    const failedMints = [];

    for (const ta of tokenAccounts) {
      const info = ta.account.data.parsed?.info;
      const mint = info?.mint;
      if (!mint || exclude.has(mint)) continue;

      let mintBalance = info?.tokenAmount?.uiAmount || 0;
      if (mintBalance <= 0) continue;

      const valueUsd = await getTokenValueUsd(mint, mintBalance);
      if (valueUsd != null && valueUsd <= config.swap.dustUsdThreshold) {
        log.debug(
          `[detail] Skipping dust ${mintBalance} ${mint.slice(0, 8)} ($${valueUsd.toFixed(3)} <= $${config.swap.dustUsdThreshold})`
        );
        continue;
      }

      let tokenSwapped = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (mintBalance <= 0) break;

        log.info(`Sweeping ${mintBalance} ${mint.slice(0, 8)} → SOL (attempt ${attempt})`);
        const result = await swapToSol(mint, mintBalance);
        if (result.success) {
          swapped++;
          totalAmount += mintBalance;
          const dustLabel = result.dust ? " (dust)" : "";
          log.info(`Swept ${mintBalance} ${mint.slice(0, 8)} → SOL${dustLabel}`);
          tokenSwapped = true;
          break;
        }

        log.warn(`Sweep attempt ${attempt} failed for ${mint.slice(0, 8)}: ${result.error}`);
        if (attempt < 3) {
          await sleep(5000);
          mintBalance = await getTokenBalance(mint);
        }
      }

      if (!tokenSwapped) {
        failedMints.push(mint);
        log.warn(`Sweep failed for ${mint.slice(0, 8)} after 3 attempts — token left unsold`);
      }
    }

    if (swapped > 0) {
      log.info(`Sweep complete: ${swapped} token(s) swapped → SOL (total ${totalAmount})`);
    }

    return { swapped, totalAmount, failedMints };
  } catch (err) {
    log.error(`sweepToSol failed: ${err.message}`);
    return { swapped: 0, totalAmount: 0, failedMints: [], error: err.message };
  }
}
