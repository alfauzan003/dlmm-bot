// Auto flip: trade bid_ask/mixed dengan `autoFlip.pct` di-flip otomatis saat harga sudah melewati
// pct% bin sisi SOL range sejak trade dibuka; dengan `autoFlip.step` diulang tiap step%.
// Dipanggil tiap siklus loop exit utama.
import log from "../core/logger.js";
import { canFlip, flipTrade } from "../lp/flip-trade.js";
import { notifyAutoFlip } from "../notify/telegram.js";
import { getTrackedPosition } from "../state/positions.js";
import { getTrade, listOpenTrades, setTradeAutoFlip, tradeLock } from "../state/trades.js";
import { fmtToken } from "../tg/format.js";

const isLegClosed = (addr) => getTrackedPosition(addr)?.closed === true;

// Perkiraan bin aktif saat buka untuk trade lama (sebelum range.activeBin disimpan).
// Lebar range dibagi menurut jarak harga log: sisi SOL ln(1/(1-below)), sisi token ln(1+above).
export function estimateOpenActive(range, xIsSol) {
  const { below, above = 0, lowerBin, upperBin } = range || {};
  if (![below, above, lowerBin, upperBin].every(Number.isFinite) || !(below > 0 && below < 100)) return null;
  const solLog = -Math.log(1 - below / 100);
  const tokenLog = Math.log(1 + Math.max(0, above) / 100);
  const solBins = Math.round(((upperBin - lowerBin) * solLog) / (solLog + tokenLog));
  return xIsSol ? upperBin - solBins : lowerBin + solBins;
}

// Persen bin sisi SOL yang sudah dilewati harga sejak buka (0..100), atau null bila tidak diketahui.
// Token = X: harga turun = bin aktif turun; SOL = X: harga token turun = bin aktif naik.
export function crossedPct(trade, positionsByAddr, { isClosed = () => false } = {}) {
  const range = trade?.range;
  if (!range || !Number.isFinite(range.lowerBin) || !Number.isFinite(range.upperBin) || !positionsByAddr) return null;
  const leg = (trade.positions || [])
    .filter((addr) => !isClosed(addr))
    .map((addr) => positionsByAddr.get(addr))
    .find((p) => p && Number.isFinite(p.activeBin));
  if (!leg) return null;
  const xIsSol = leg.xIsSol === true;
  const open = Number.isFinite(range.activeBin) ? range.activeBin : estimateOpenActive(range, xIsSol);
  if (!Number.isFinite(open)) return null;
  const solBins = xIsSol ? range.upperBin - open : open - range.lowerBin;
  if (!(solBins > 0)) return null;
  const crossed = xIsSol ? leg.activeBin - open : open - leg.activeBin;
  return Math.min(100, Math.max(0, (crossed / solBins) * 100));
}

function failReason(res) {
  if (res.redepositFailed) return "withdrawn but re-deposit failed — token kept in wallet";
  if (res.binCount === 0 && !res.error) return "nothing to flip — no token-only bins yet";
  return res.error ?? "unknown error";
}

// Ambang auto flip berikutnya: level pct + k·step (k >= 1) pertama yang > crossed; null bila tanpa
// step atau lewat 100%. Turun cepat melewati beberapa level -> langsung ke level di atas crossed.
export function nextAutoFlipPct(pct, step, crossed) {
  if (!(step > 0)) return null;
  let next = pct + (Math.floor((crossed - pct) / step) + 1) * step;
  if (next <= crossed) next += step;
  return next > 100 ? null : next;
}

// Teks notifikasi hasil auto flip (polos, tanpa HTML). nextPct = ambang berikutnya (null = mati).
export function autoFlipMessage(trade, pct, res, nextPct = null) {
  const head = `#${trade.id} ${trade.pair} at ${Math.round(pct)}% crossed`;
  const n = res.binCount;
  const tail = nextPct != null ? `Next auto flip at ${Math.round(nextPct * 10) / 10}%.` : "Auto flip turned off.";
  if (res.dryRun) return `🧪 DRY RUN — auto flip ${head} would flip ${n} bins. ${tail}`;
  if (res.success) {
    return `🤖 Auto flip ${head}: flipped ${n} bins (${fmtToken(res.tokenAmount)} token) → one position over ${n} bins. ${tail}`;
  }
  return `⚠️ Auto flip ${head} failed: ${failReason(res)}. Auto flip turned off.`;
}

// Satu siklus: flip trade yang sudah melewati ambangnya. Busy (trade/pool) atau error tak terduga
// → tetap aktif, dicoba siklus berikutnya; sukses / dry run → level berikutnya (step) atau mati;
// gagal → dimatikan. Selalu ada notifikasi kecuali busy/error.
export async function runAutoFlips(positions, { deps = {} } = {}) {
  const flip = deps.flipTrade ?? flipTrade;
  const notify = deps.notify ?? notifyAutoFlip;
  const live = new Map((positions || []).filter((p) => p?.position).map((p) => [p.position, p]));

  for (const trade of listOpenTrades()) {
    if (!(trade.autoFlip?.pct > 0) || !canFlip(trade) || tradeLock(trade.id)) continue;
    const pct = crossedPct(trade, live, { isClosed: isLegClosed });
    if (pct == null || pct < trade.autoFlip.pct) continue;

    const label = `Auto flip #${trade.id} ${trade.pair}`;
    log.info(`${label}: ${pct.toFixed(1)}% sisi SOL terlewati (ambang ${trade.autoFlip.pct}%) → flip`);
    let res;
    try {
      res = await flip(trade);
    } catch (err) {
      log.warn(`${label}: error (${err?.message ?? err}) — coba lagi siklus berikutnya`);
      continue;
    }
    if (res?.busy || res?.poolBusy) {
      log.info(`${label}: trade/pool sibuk — coba lagi siklus berikutnya`);
      continue;
    }
    // Sukses / dry run dengan step -> lanjut ke level berikutnya; selain itu mati.
    // Pengguna bisa mengubah auto flip selama flip berjalan: nilai barunya dihormati (tidak ditimpa).
    const current = getTrade(trade.id)?.autoFlip ?? null;
    if (JSON.stringify(current) !== JSON.stringify(trade.autoFlip)) {
      notify(autoFlipMessage(trade, pct, res ?? {}, current?.pct ?? null));
      continue;
    }
    const { step } = trade.autoFlip;
    const next = res?.success ? nextAutoFlipPct(trade.autoFlip.pct, step, pct) : null;
    setTradeAutoFlip(trade.id, next == null ? null : { pct: next, step });
    notify(autoFlipMessage(trade, pct, res ?? {}, next));
  }
}
