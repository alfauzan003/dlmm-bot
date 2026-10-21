import { PublicKey } from "@solana/web3.js";
import { WSOL_MINT } from "../core/constants.js";
import { getConnection } from "../solana/connection.js";
import { getDlmmSdk } from "../meteora/sdk.js";

export const baseMintCache = new Map();
export const pairNameCache = new Map();

export async function getPoolInfo(poolAddress) {
  const { DLMM } = await getDlmmSdk();
  const connection = getConnection();
  const pool = await DLMM.create(connection, new PublicKey(poolAddress));

  const cached = baseMintCache.get(poolAddress);
  if (cached) return { pool, ...cached };

  const xMint = pool.lbPair.tokenXMint?.toString() || "";
  const yMint = pool.lbPair.tokenYMint?.toString() || "";
  const isXSol = xMint === WSOL_MINT;
  const isYSol = yMint === WSOL_MINT;
  const unsupported = !isXSol && !isYSol;

  let baseMint = null;
  let baseIsX = false;
  let quoteMint = null;
  if (isXSol) {
    baseMint = yMint;
    baseIsX = false;
    quoteMint = xMint;
  } else if (isYSol) {
    baseMint = xMint;
    baseIsX = true;
    quoteMint = yMint;
  }

  let pairName = null;
  if (!pairNameCache.has(poolAddress)) {
    try {
      const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${poolAddress}`);
      if (res.ok) {
        const data = await res.json();
        pairName = data?.name || null;
      }
    } catch {
      // non-critical
    }
    pairNameCache.set(poolAddress, pairName);
  } else {
    pairName = pairNameCache.get(poolAddress);
  }

  const info = {
    baseMint,
    baseIsX,
    xMint,
    yMint,
    quoteMint,
    unsupported,
    pairName,
    collectFeeMode: pool.lbPair.parameters?.collectFeeMode ?? null,
  };
  baseMintCache.set(poolAddress, info);
  return { pool, ...info };
}
