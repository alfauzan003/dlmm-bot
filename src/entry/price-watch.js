import config from "../config/index.js";
import log from "../core/logger.js";
import { WSOL_MINT } from "../core/constants.js";
import { getPrices } from "../market/jupiter-price.js";
import { ensureSupertrend, getSupertrend, getSupertrendFallback } from "../market/supertrend-state.js";

// Harga Jupiter terakhir per mint (untuk ringkasan log).
const lastPrices = new Map();
let lastPricesAt = 0;

export function getLastPrices() {
  return lastPrices;
}

export function getLastPricesAt() {
  return lastPricesAt;
}

// State machine sinyal entry:
//   1. GMGN 15m (candle tutup) menentukan arah + garis Supertrend.
//   2. Hanya bullish yang dipantau.
//   3. Jupiter memantau harga real-time; harga <= garis -> entry (first_touch).
//
// `candidates`: [{ pool, mint }]
// `deps` (opsional, untuk test): { getSupertrend, getSupertrendFallback, ensureSupertrend, getPrices }
// Mengembalikan: { triggered: [{ pool, mint, line, price, direction }], pending: n }
export async function watchPrices(candidates = [], deps = {}) {
  const getST = deps.getSupertrend || getSupertrend;
  const getSTFallback = deps.getSupertrendFallback || getSupertrendFallback;
  const ensure = deps.ensureSupertrend || ensureSupertrend;
  const fetchPrices = deps.getPrices || getPrices;

  // Picu penyegaran garis (non-blocking) untuk semua kandidat.
  for (const c of candidates) ensure(c.mint);

  const bullish = [];
  for (const c of candidates) {
    // Pakai garis bar terbaru; saat transisi bar (garis belum siap), pakai
    // garis bar sebelumnya agar evaluasi entry tidak terlewat.
    const st = getST(c.mint) || getSTFallback(c.mint);
    if (st && st.direction === "bullish") bullish.push({ ...c, line: st.line });
  }

  if (bullish.length === 0) return { triggered: [], pending: candidates.length };

  // WSOL disertakan agar referensi harga pasar SOL/USD tersedia untuk rem harga.
  const prices = await fetchPrices([...bullish.map((b) => b.mint), WSOL_MINT]);
  for (const [mint, price] of prices) {
    if (Number.isFinite(price)) lastPrices.set(mint, price);
  }
  if (prices.size) lastPricesAt = Date.now();

  const tolerance = Math.max(0, Number(config.entryTouchTolerancePct) || 0) / 100;
  const triggered = [];

  for (const b of bullish) {
    const price = prices.get(b.mint);
    if (price == null) continue;
    if (price <= b.line * (1 + tolerance)) {
      triggered.push({
        pool: b.pool,
        mint: b.mint,
        line: b.line,
        price,
        solPrice: prices.get(WSOL_MINT),
        direction: "bullish",
      });
    }
  }

  if (triggered.length > 0) {
    log.debug(`[detail] watchPrices: ${triggered.length}/${candidates.length} sentuh garis (bullish)`);
  }

  return { triggered, pending: candidates.length - bullish.length };
}
