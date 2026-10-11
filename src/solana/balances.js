import { PublicKey } from "@solana/web3.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { WSOL_MINT, TOKEN_PROGRAM_ID } from "../core/constants.js";
import { getConnection } from "./connection.js";
import { getWallet } from "./wallet.js";

const JUPITER_PRICE = "https://api.jup.ag/price/v3";

// Baca harga Jupiter tanpa API key (bucket IP, tidak mengganggu kuota key
// harga/swap). Bila ditolak, fallback sekali memakai key swap.
async function fetchPriceData(ids) {
  const url = `${JUPITER_PRICE}?ids=${ids}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.ok) return await res.json();
    if (config.jupiterSwapApiKey) {
      const retry = await fetch(url, {
        headers: { "x-api-key": config.jupiterSwapApiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (retry.ok) return await retry.json();
    }
  } catch {}
  return null;
}

export async function getMintDecimals(mint) {
  if (mint === WSOL_MINT || mint === "SOL") return 9;
  try {
    const connection = getConnection();
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    return info.value?.data?.parsed?.info?.decimals ?? 9;
  } catch {
    return 9;
  }
}

export async function getTokenBalance(mint) {
  const connection = getConnection();
  const wallet = getWallet();

  if (mint === WSOL_MINT || mint === "SOL") {
    const balance = await connection.getBalance(wallet.publicKey);
    return balance / 1e9;
  }

  try {
    const tokenMint = new PublicKey(mint);
    const tokenAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint: tokenMint });
    if (tokenAccounts.value.length === 0) return 0;

    const accountInfo = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
    return Number(accountInfo.value.uiAmount || 0);
  } catch {
    return 0;
  }
}

export async function getTokenValueUsd(mint, amount) {
  if (!mint || !amount || amount <= 0) return null;
  try {
    const data = await fetchPriceData(mint);
    if (!data) return null;
    const entry = data?.[mint];
    const rawPrice = entry?.usdPrice ?? entry?.price;
    const price = Number(rawPrice);
    if (!Number.isFinite(price)) return null;
    return amount * price;
  } catch {
    return null;
  }
}

export async function getWalletBalances() {
  const connection = getConnection();
  const wallet = getWallet();

  try {
    const solBalance = await connection.getBalance(wallet.publicKey);
    const result = {
      sol: solBalance / 1e9,
      tokens: [],
    };

    const tokenProgramId = new PublicKey(TOKEN_PROGRAM_ID);
    const { value: tokenAccounts } = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: tokenProgramId,
    });

    const mints = [];
    const balanceByMint = {};
    for (const ta of tokenAccounts) {
      const info = ta.account.data.parsed?.info;
      const mint = info?.mint;
      const uiAmount = info?.tokenAmount?.uiAmount || 0;
      if (!mint || mint === WSOL_MINT || uiAmount <= 0) continue;
      mints.push(mint);
      balanceByMint[mint] = uiAmount;
    }

    let priceMap = {};
    if (mints.length > 0) {
      try {
        const priceData = await fetchPriceData(mints.join(","));
        if (priceData) {
          priceMap = priceData?.data || priceData || {};
        }
      } catch {}
    }

    for (const mint of mints) {
      const balance = balanceByMint[mint];
      const rawPrice = priceMap[mint]?.usdPrice ?? priceMap[mint]?.price;
      const priceInUsd = Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : null;
      result.tokens.push({
        mint,
        balance,
        usd: priceInUsd ? balance * priceInUsd : null,
        symbol: priceMap[mint]?.symbol || mint.slice(0, 8),
      });
    }

    return result;
  } catch (err) {
    log.warn(`getWalletBalances failed: ${err.message}`);
    return { sol: 0, tokens: [] };
  }
}
