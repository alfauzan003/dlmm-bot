import { WSOL_MINT } from "../core/constants.js";

// Verifikasi "modal asli" posisi dari riwayat on-chain, karena Meteora datapi
// kadang salah menilai sisi token saat deposit (harga token ter-revaluasi
// ekstrem). Nilai sisi SOL tetap dipakai dari datapi (tidak ter-revaluasi),
// sedangkan sisi token diganti dengan SOL yang benar-benar dipakai membeli
// token tepat sebelum setoran.

const DEFAULT_CONCURRENCY = 4;
const BUY_LOOKBACK_SEC = 300; // beli token biasanya tepat sebelum add-liquidity
const TOKEN_MATCH_TOLERANCE = 0.5; // beda jumlah token > 50% → anggap tak cocok

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function rpcCall(rpcUrl, method, params, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return json.result;
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getWalletSignatures(rpcUrl, wallet, fromSec, toSec) {
  const out = [];
  let before;
  for (;;) {
    const params = [wallet, { limit: 1000 }];
    if (before) params[1].before = before;
    const batch = await rpcCall(rpcUrl, "getSignaturesForAddress", params);
    if (!batch.length) break;
    out.push(...batch);
    const oldest = batch[batch.length - 1];
    if (!oldest.blockTime || oldest.blockTime < fromSec) break;
    before = oldest.signature;
    if (out.length > 20000) break;
  }
  return out.filter((s) => s.blockTime != null && s.blockTime >= fromSec && s.blockTime <= toSec);
}

function tokenDeltasFor(tx, wallet) {
  const deltas = {};
  const add = (arr, sign) => {
    for (const b of arr || []) {
      if (b.owner !== wallet) continue;
      const amt = b.uiTokenAmount?.uiAmount;
      const q = amt != null ? amt : Number(b.uiTokenAmount?.uiAmountString) || 0;
      if (!Number.isFinite(q)) continue;
      deltas[b.mint] = (deltas[b.mint] || 0) + sign * q;
    }
  };
  add(tx.meta?.preTokenBalances, -1);
  add(tx.meta?.postTokenBalances, 1);
  return deltas;
}

// Ambil semua transaksi wallet dalam rentang waktu, ringkas jadi daftar
// perpindahan saldo (SOL + token) untuk pencocokan beli/setor.
export async function collectWalletFlows(wallet, fromMs, toMs, { rpcUrl, concurrency = DEFAULT_CONCURRENCY } = {}) {
  if (!rpcUrl) throw new Error("rpcUrl wajib diisi untuk verifikasi on-chain");
  const fromSec = Math.floor(fromMs / 1000);
  const toSec = Math.floor(toMs / 1000);
  const sigs = await getWalletSignatures(rpcUrl, wallet, fromSec, toSec);
  const flows = await mapLimit(sigs, concurrency, async (s) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const tx = await rpcCall(
          rpcUrl,
          "getTransaction",
          [s.signature, { maxSupportedTransactionVersion: 1, encoding: "json" }],
          2
        );
        if (!tx?.meta) return null;
        const accountKeys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
        const idx = accountKeys.indexOf(wallet);
        const nativeSol = idx >= 0 ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9 : 0;
        const tokenDeltas = tokenDeltasFor(tx, wallet);
        // SOL bisa dipegang sebagai native maupun wrapped (WSOL). Biaya beli token
        // kadang memakai WSOL sehingga delta native SOL hampir nol (hanya gas).
        const solDelta = nativeSol + (tokenDeltas[WSOL_MINT] || 0);
        return {
          signature: s.signature,
          slot: s.slot,
          blockTime: s.blockTime,
          solDelta,
          nativeSolDelta: nativeSol,
          tokenDeltas,
          accountKeys,
        };
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    return null;
  });
  return flows.filter(Boolean).sort((a, b) => a.blockTime - b.blockTime);
}

// Bandingkan modal deposit versi datapi dengan modal on-chain. Bila beda di
// atas thresholdPct, hitung ulang PnL pakai modal on-chain.
// PnL = (nilai sekarang − modal). Nilai sekarang = pnlSol + depositSol (berlaku
// untuk posisi closed maupun open).
export function reconcilePosition(pos, flows, { thresholdPct = 25 } = {}) {
  const deposits = pos.allTimeDeposits || {};
  const apiDepSol = num(deposits.total?.sol);
  const apiDepUsd = num(deposits.total?.usd);
  const apiPnlSol = num(pos.pnlSol);
  const apiPnlUsd = num(pos.pnlUsd);

  const result = {
    corrected: false,
    verified: true,
    reason: "",
    depositSol: apiDepSol,
    depositUsd: apiDepUsd,
    pnlSol: apiPnlSol,
    pnlUsd: apiPnlUsd,
  };

  const xIsSol = pos.tokenX === WSOL_MINT;
  const yIsSol = pos.tokenY === WSOL_MINT;
  if (xIsSol === yIsSol) return { ...result, verified: false, reason: "pasangan bukan token-SOL" };

  const baseIsX = !xIsSol;
  const baseSide = baseIsX ? deposits.tokenX : deposits.tokenY;
  const solSide = baseIsX ? deposits.tokenY : deposits.tokenX;
  const baseMint = baseIsX ? pos.tokenX : pos.tokenY;
  const baseDepAmt = num(baseSide?.amount);
  // Per sisi token memakai field "amountSol"; "sol" hanya ada di total.
  const solDepSol = num(solSide?.amountSol);
  const solDepUsd = num(solSide?.usd);

  if (!(baseDepAmt > 0) || !baseMint || !pos.positionAddress) return result;

  const solPrice = solDepSol > 0 ? solDepUsd / solDepSol : 0;
  const closedSec = num(pos.closedAt) || Infinity;

  const addTxs = flows
    .filter(
      (f) => f.accountKeys.includes(pos.positionAddress) && f.blockTime <= closedSec && num(f.tokenDeltas[baseMint]) < 0
    )
    .sort((a, b) => a.blockTime - b.blockTime);

  const usedBuys = new Set();
  let buyCostSol = 0;
  let buyTokens = 0;
  for (const add of addTxs) {
    const buy = flows
      .filter(
        (f) =>
          f.blockTime <= add.blockTime &&
          add.blockTime - f.blockTime <= BUY_LOOKBACK_SEC &&
          !usedBuys.has(f.signature) &&
          !f.accountKeys.includes(pos.positionAddress) &&
          num(f.tokenDeltas[baseMint]) > 0
      )
      .sort((a, b) => b.blockTime - a.blockTime)[0];
    if (!buy) continue;
    usedBuys.add(buy.signature);
    buyCostSol += Math.abs(num(buy.solDelta));
    buyTokens += num(buy.tokenDeltas[baseMint]);
  }

  if (!addTxs.length || !usedBuys.size || buyCostSol <= 0) {
    return { ...result, verified: false, reason: "transaksi beli on-chain tak ditemukan" };
  }
  if (Math.abs(buyTokens - baseDepAmt) / baseDepAmt > TOKEN_MATCH_TOLERANCE) {
    return { ...result, verified: false, reason: "jumlah token on-chain tidak cocok" };
  }

  const onchainDepSol = buyCostSol + solDepSol;
  if (!(onchainDepSol > 0)) return { ...result, verified: false, reason: "modal on-chain tak terhitung" };
  const onchainDepUsd =
    solPrice > 0 ? buyCostSol * solPrice + solDepUsd : apiDepSol > 0 ? onchainDepSol * (apiDepUsd / apiDepSol) : 0;

  const diffPct = (Math.abs(apiDepSol - onchainDepSol) / onchainDepSol) * 100;
  if (diffPct <= thresholdPct) return { ...result, verified: true, reason: "", onchainDepSol, diffPct };

  const currentValueSol = apiPnlSol + apiDepSol;
  const currentValueUsd = apiPnlUsd + apiDepUsd;

  return {
    corrected: true,
    verified: true,
    reason: `deposit Meteora ${apiDepSol.toFixed(5)} → on-chain ${onchainDepSol.toFixed(5)} (${diffPct.toFixed(0)}%)`,
    depositSol: onchainDepSol,
    depositUsd: onchainDepUsd,
    pnlSol: currentValueSol - onchainDepSol,
    pnlUsd: currentValueUsd - onchainDepUsd,
    onchainDepSol,
    diffPct,
  };
}
