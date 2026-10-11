import { WSOL_MINT } from "../core/constants.js";
import { getPrices } from "../market/jupiter-price.js";
import { sleep as defaultSleep } from "../core/utils.js";

// Harga pool (SOL per token base) dari bin aktif. `pricePerToken` mengikuti
// orientasi pool (tokenY per tokenX), jadi dibalik bila base adalah tokenY.
export function poolPriceSolPerToken(activeBin, baseIsX) {
  const pricePerToken = Number(activeBin?.pricePerToken);
  if (!Number.isFinite(pricePerToken) || pricePerToken <= 0) return null;
  return baseIsX ? pricePerToken : 1 / pricePerToken;
}

// Bandingkan harga aktif pool dengan harga pasar. `tokenUsd`/`solUsd` opsional
// (snapshot dari trigger entry). Kalau kosong, ambil harga segar dari Jupiter.
// Mengembalikan: { ok, unavailable, deviationPct, poolSolPerToken, marketSolPerToken }
// `unavailable` = harga pasar tidak tersedia (pemanggil memutuskan fail-open).
export async function checkPoolPriceDeviation({
  baseMint,
  baseIsX,
  activeBin,
  thresholdPct,
  tokenUsd,
  solUsd,
  fetchPrices = getPrices,
} = {}) {
  const poolSolPerToken = poolPriceSolPerToken(activeBin, baseIsX);
  if (poolSolPerToken == null) {
    return { ok: true, unavailable: true, reason: "harga pool tidak tersedia" };
  }

  // null/undefined/0 dianggap tidak tersedia (mis. DCA mengirim price: null).
  let t = Number(tokenUsd);
  let s = Number(solUsd);
  if (tokenUsd == null || !Number.isFinite(t) || t <= 0) t = NaN;
  if (solUsd == null || !Number.isFinite(s) || s <= 0) s = NaN;
  if (!Number.isFinite(t) || !Number.isFinite(s)) {
    const prices = await fetchPrices([baseMint, WSOL_MINT], { force: true });
    if (!Number.isFinite(t)) t = prices.get(baseMint);
    if (!Number.isFinite(s)) s = prices.get(WSOL_MINT);
  }

  if (!Number.isFinite(t) || !Number.isFinite(s) || s <= 0) {
    return {
      ok: true,
      unavailable: true,
      reason: "harga pasar tidak tersedia",
      poolSolPerToken,
    };
  }

  const marketSolPerToken = t / s;
  const deviationPct = (poolSolPerToken / marketSolPerToken - 1) * 100;
  const limit = Math.max(0, Number(thresholdPct) || 0);
  const ok = Math.abs(deviationPct) <= limit;

  return { ok, unavailable: false, deviationPct, poolSolPerToken, marketSolPerToken };
}

// Baca bin aktif + cek deviasi, dengan percobaan ulang saat masih menyimpang.
// `getActiveBin`, `check`, dan `sleepFn` bisa di-inject untuk pengujian.
// Mengembalikan: { activeBin, guard, exhausted, attempts }.
export async function guardPoolPrice({
  getActiveBin,
  baseMint,
  baseIsX,
  thresholdPct,
  signalTokenUsd,
  signalSolUsd,
  attempts = 1,
  delayMs = 0,
  onRetry,
  onUnavailable,
  check = checkPoolPriceDeviation,
  sleepFn = defaultSleep,
} = {}) {
  const max = Math.max(1, Math.floor(Number(attempts) || 1));
  const delay = Math.max(0, Number(delayMs) || 0);
  let activeBin = null;

  for (let attempt = 1; attempt <= max; attempt++) {
    activeBin = await getActiveBin();
    const guard = await check({
      baseMint,
      baseIsX,
      activeBin,
      thresholdPct,
      // Percobaan pertama boleh pakai snapshot sinyal; retry pakai harga segar.
      tokenUsd: attempt === 1 ? signalTokenUsd : undefined,
      solUsd: attempt === 1 ? signalSolUsd : undefined,
    });

    if (guard.unavailable) {
      onUnavailable?.(guard);
      return { activeBin, guard, exhausted: false, attempts: attempt, delayMs: delay };
    }
    if (guard.ok) return { activeBin, guard, exhausted: false, attempts: attempt, delayMs: delay };
    if (attempt >= max) return { activeBin, guard, exhausted: true, attempts: attempt, delayMs: delay };

    onRetry?.({ attempt, attempts: max, deviationPct: guard.deviationPct, delayMs: delay });
    if (delay > 0) await sleepFn(delay);
  }

  return { activeBin, guard: null, exhausted: false, attempts: max, delayMs: delay };
}
