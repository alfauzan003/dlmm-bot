import { PublicKey } from "@solana/web3.js";
import { WSOL_MINT } from "../core/constants.js";
import { getConnection } from "../solana/connection.js";
import { getPoolInfo } from "../entry/pool-info.js";
import { shortAddr } from "../tg/format.js";

const DATAPI_POOLS = "https://dlmm.datapi.meteora.ag/pools";
const INVALID_REASON = "not a DLMM pool or token with a SOL pool";
const MAX_POOLS = 5;

let _programId = null;

async function dlmmProgramId() {
  if (!_programId) {
    const { LBCLMM_PROGRAM_IDS } = await import("@meteora-ag/dlmm");
    _programId = LBCLMM_PROGRAM_IDS["mainnet-beta"];
  }
  return _programId;
}

const defaultDeps = {
  getAccountInfo: (address) => getConnection().getAccountInfo(new PublicKey(address)),
  fetchJson: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`datapi ${res.status}`);
    return res.json();
  },
  getPoolInfo,
};

function isValidAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// Respons datapi: { address, name, token_x.address, token_y.address,
// pool_config.{bin_step, base_fee_pct}, tvl, volume["24h"] }.
function toSummary(p) {
  return {
    address: p.address,
    name: p.name,
    binStep: p.pool_config?.bin_step,
    baseFeePct: p.pool_config?.base_fee_pct,
    tvlUsd: Number(p.tvl) || 0,
    volume24hUsd: Number(p.volume?.["24h"]) || 0,
  };
}

function isSolPoolOf(p, mint) {
  const x = p.token_x?.address;
  const y = p.token_y?.address;
  return (x === WSOL_MINT && y === mint) || (y === WSOL_MINT && x === mint);
}

// Alamat yang ditempel user: pool DLMM, atau mint token (-> pool SOL teratas).
export async function resolveAddress(address, { deps } = {}) {
  const d = { ...defaultDeps, ...deps };
  const invalid = { type: "invalid", reason: INVALID_REASON };
  if (!isValidAddress(address)) return invalid;

  const account = await d.getAccountInfo(address);
  if (account && account.owner?.toString() === (await dlmmProgramId())) {
    const info = await d.getPoolInfo(address);
    if (info.unsupported) return { type: "not_sol", pair: info.pairName ?? shortAddr(address) };
    return { type: "pool", pool: { address, name: info.pairName ?? shortAddr(address), baseMint: info.baseMint } };
  }

  const res = await d.fetchJson(`${DATAPI_POOLS}?query=${address}&page_size=50`);
  const pools = (res?.data ?? [])
    .filter((p) => isSolPoolOf(p, address))
    .map(toSummary)
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, MAX_POOLS);
  return pools.length ? { type: "mint", pools } : invalid;
}

function fmtCompactUsd(n) {
  const strip = (v) => v.replace(/\.0$/, "");
  if (n >= 1e6) return `$${strip((n / 1e6).toFixed(1))}M`;
  if (n >= 1e4) return `$${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `$${strip((n / 1e3).toFixed(1))}K`;
  return `$${Math.round(n)}`;
}

export function poolButtonLabel(s) {
  return `bin ${s.binStep} · ${Number(s.baseFeePct)}% · TVL ${fmtCompactUsd(s.tvlUsd)} · Vol ${fmtCompactUsd(s.volume24hUsd)}`;
}
