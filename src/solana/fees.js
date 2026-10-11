import config from "../config/index.js";

const LAMPORTS_PER_SOL = 1e9;
// Perkiraan compute unit tx entry DLMM (init position + add liquidity). Hanya
// dipakai untuk pengecekan batas biaya sebelum CU sebenarnya diketahui.
const DEFAULT_CU_ESTIMATE = 400_000;

export const FEE_MODES = ["none", "priority", "jito", "both"];

export function parseFeeMode(raw) {
  const value = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase();
  return FEE_MODES.includes(value) ? value : "none";
}

// Bangun rencana fee dari config. Tidak menyentuh RPC.
export function buildFeePlan() {
  const fees = config.entry.fees;
  const plan = {
    mode: fees.mode,
    priorityMicroLamports: 0,
    computeUnitLimit: 0,
    jitoTipLamports: 0,
    jitoTipAccount: null,
  };

  if (fees.mode === "priority" || fees.mode === "both") {
    plan.priorityMicroLamports = Math.max(0, Math.floor(fees.priorityMicroLamports));
    plan.computeUnitLimit = Math.max(0, Math.floor(fees.computeUnitLimit));
  }
  if (fees.mode === "jito" || fees.mode === "both") {
    plan.jitoTipLamports = Math.max(0, Math.floor(fees.jitoTipSol * LAMPORTS_PER_SOL));
  }

  return plan;
}

// Estimasi total biaya (base + priority + tip) dalam SOL.
export function estimateFeeSol(plan, { computeUnits, feePayerSignatures = 2 } = {}) {
  if (!plan || plan.mode === "none") return 0;
  const cu = computeUnits != null ? computeUnits : plan.computeUnitLimit || DEFAULT_CU_ESTIMATE;
  const base = 5000 * Math.max(0, feePayerSignatures);
  const priority = plan.priorityMicroLamports > 0 ? Math.ceil((plan.priorityMicroLamports * cu) / 1e6) : 0;
  const tip = plan.jitoTipLamports || 0;
  return (base + priority + tip) / LAMPORTS_PER_SOL;
}

// Pastikan estimasi biaya tidak melebihi ENTRY_FEE_MAX_SOL.
export function checkFeeCap(plan, opts = {}) {
  const cap = config.entry.fees.maxSol;
  const totalSol = estimateFeeSol(plan, opts);
  const ok = !(cap > 0 && totalSol > cap);
  return { ok, totalSol, cap };
}
