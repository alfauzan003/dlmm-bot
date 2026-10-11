import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePosition } from "../src/meteora/pnl-reconcile.js";

const WALLET = "Wallet1111111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const BASE = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";
const POS = "Pos111111111111111111111111111111111111111";
const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

function basePosition(overrides = {}) {
  return {
    positionAddress: POS,
    tokenX: BASE,
    tokenY: WSOL,
    createdAt: 1000,
    closedAt: 2000,
    pnlSol: -0.3088856878495956,
    pnlUsd: -36.7738,
    allTimeDeposits: {
      tokenX: { amount: "2665.876076", amountSol: "0.5467971172743511", usd: "65.12455170230203" },
      tokenY: { amount: "0.249999981", amountSol: "0.249999981", usd: "29.775461819123112" },
      total: { sol: "0.7967970982743512", usd: "94.90001352142515" },
    },
    allTimeWithdrawals: { total: { sol: "0.471853739750406", usd: "56.21319147286937" } },
    allTimeFees: { total: { sol: "0.01605767067434959", usd: "1.9129930319148563" } },
    ...overrides,
  };
}

const buyFlow = {
  signature: "buy",
  blockTime: 900,
  solDelta: -0.25018,
  tokenDeltas: { [BASE]: 2665.876092 },
  accountKeys: [WALLET, "Jupiter"],
};

const addFlow = {
  signature: "add",
  blockTime: 1000,
  solDelta: -0.39619,
  tokenDeltas: { [BASE]: -2665.876092 },
  accountKeys: [WALLET, POS, DLMM],
};

const closeFlow = {
  signature: "close",
  blockTime: 2000,
  solDelta: 0.48,
  tokenDeltas: { [BASE]: 4600.734314 },
  accountKeys: [WALLET, POS, DLMM],
};

test("koreksi deposit token yang dinilai 2x oleh Meteora", () => {
  const rec = reconcilePosition(basePosition(), [buyFlow, addFlow, closeFlow], { thresholdPct: 25 });
  assert.equal(rec.corrected, true);
  assert.equal(rec.verified, true);
  assert.ok(Math.abs(rec.depositSol - 0.50018) < 1e-6, `deposit ${rec.depositSol}`);
  assert.ok(Math.abs(rec.pnlSol - -0.01227) < 1e-4, `pnl ${rec.pnlSol}`);
  assert.ok(rec.pnlSol > basePosition().pnlSol);
});

test("deposit cocok on-chain → tidak dikoreksi", () => {
  const pos = basePosition({
    allTimeDeposits: {
      tokenX: { amount: "2665.876076", amountSol: "0.25018", usd: "29.79" },
      tokenY: { amount: "0.249999981", amountSol: "0.249999981", usd: "29.775461819123112" },
      total: { sol: "0.500179981", usd: "59.56546181912311" },
    },
  });
  const rec = reconcilePosition(pos, [buyFlow, addFlow, closeFlow], { thresholdPct: 25 });
  assert.equal(rec.corrected, false);
  assert.equal(rec.verified, true);
  assert.equal(rec.depositSol, 0.500179981);
  assert.equal(rec.pnlSol, pos.pnlSol);
});

test("pasangan bukan token-SOL → tak terverifikasi", () => {
  const rec = reconcilePosition(basePosition({ tokenY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), [], {});
  assert.equal(rec.corrected, false);
  assert.equal(rec.verified, false);
  assert.match(rec.reason, /bukan/);
});

test("tanpa transaksi add on-chain → tak terverifikasi", () => {
  const rec = reconcilePosition(basePosition(), [buyFlow, closeFlow], { thresholdPct: 25 });
  assert.equal(rec.corrected, false);
  assert.equal(rec.verified, false);
  assert.match(rec.reason, /tak ditemukan/);
});

test("posisi open: PnL dikoreksi dari nilai sekarang − modal on-chain", () => {
  const pos = basePosition({ closedAt: 0 });
  const rec = reconcilePosition(pos, [buyFlow, addFlow], { thresholdPct: 25 });
  assert.equal(rec.corrected, true);
  const currentValueSol = pos.pnlSol + Number(pos.allTimeDeposits.total.sol);
  assert.ok(Math.abs(rec.pnlSol - (currentValueSol - 0.50018)) < 1e-6);
});

test("DCA: menjumlahkan beberapa beli + setor", () => {
  const add2 = {
    signature: "add2",
    blockTime: 1500,
    solDelta: -0.2,
    tokenDeltas: { [BASE]: -1000 },
    accountKeys: [WALLET, POS, DLMM],
  };
  const buy2 = {
    signature: "buy2",
    blockTime: 1400,
    solDelta: -0.1,
    tokenDeltas: { [BASE]: 1000 },
    accountKeys: [WALLET, "Jupiter"],
  };
  const pos = basePosition({
    allTimeDeposits: {
      tokenX: { amount: "3665.876076", amountSol: "0.75", usd: "89" },
      tokenY: { amount: "0.449999981", amountSol: "0.449999981", usd: "53.5" },
      total: { sol: "1.199999981", usd: "142.5" },
    },
  });
  const rec = reconcilePosition(pos, [buyFlow, addFlow, buy2, add2, closeFlow], { thresholdPct: 25 });
  assert.equal(rec.corrected, true);
  assert.ok(Math.abs(rec.depositSol - (0.25018 + 0.1 + 0.449999981)) < 1e-6, `deposit ${rec.depositSol}`);
});
