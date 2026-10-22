// Exit strategi Auto Entry: trade auto ditutup saat cycle_done / pumped_away / range_broken /
// volume_died / max_hold (evaluator murni di strategy/exits.js). Jalan tiap siklus loop exit utama,
// terlepas dari toggle Auto Entry. Parameter = snapshot saat entry (trade.strategy.params).
import log from "../core/logger.js";
import { closeTrade as defaultCloseTrade } from "../lp/close-trade.js";
import { getTrackedPosition } from "../state/positions.js";
import { listOpenTrades, setTradeStrategyState, tradeLock } from "../state/trades.js";
import { evaluateStrategyExit, strategyExitDetail } from "../strategy/exits.js";
import { fetchRecentBars as defaultFetchRecentBars } from "../strategy/sources.js";

const isLegClosed = (addr) => getTrackedPosition(addr)?.closed === true;

const BAR_SEC = 300;

// Volume slot 5m tertutup terakhir (maks lowVolumeBars, urut waktu), hanya slot yang mulai >= openedAt.
// Meteora tidak mengirim bar bervolume 0 -> slot tanpa bar = 0. Fetch gagal/kosong -> [] (tidak pernah melempar).
async function loadVolumes(trade, p, now, fetchRecentBars) {
  if (!(p.lowVolumeBars > 0)) return [];
  try {
    const bars = await fetchRecentBars(trade.pool, p.lowVolumeBars + 2);
    if (!Array.isArray(bars) || bars.length === 0) return [];
    const volumeAt = new Map(bars.map((b) => [b.time, b.volume]));
    const current = Math.floor(now / 1000 / BAR_SEC) * BAR_SEC;
    const out = [];
    for (let k = p.lowVolumeBars; k >= 1; k--) {
      const start = current - BAR_SEC * k;
      if (start * 1000 < trade.openedAt) continue;
      const v = Number(volumeAt.get(start));
      out.push(Number.isFinite(v) ? v : 0);
    }
    return out;
  } catch {
    return [];
  }
}

// Satu siklus: evaluasi tiap trade auto terbuka; mengembalikan id trade yang berhasil ditutup.
export async function runStrategyExits(positions, { deps = {}, now = Date.now() } = {}) {
  const close = deps.closeTrade ?? defaultCloseTrade;
  const fetchRecentBars = deps.fetchRecentBars ?? defaultFetchRecentBars;
  const live = new Map((positions || []).filter((p) => p?.position).map((p) => [p.position, p]));
  const closed = [];

  for (const trade of listOpenTrades()) {
    if (!trade.strategy?.params || tradeLock(trade.id)) continue;
    try {
      const legs = (trade.positions || []).filter((addr) => !isLegClosed(addr)).map((addr) => live.get(addr)).filter(Boolean);
      if (legs.length === 0) continue;
      const flipSet = new Set(trade.flipLegs || []);
      // activeBin null (RPC kosong) dibaca sebagai bin 0 → jangan evaluasi tanpa bin aktif yang valid.
      const known = legs.filter((l) => Number.isFinite(l.activeBin));
      const main = known.find((l) => !flipSet.has(l.position)) ?? known[0];
      if (!main) continue;
      const p = trade.strategy.params;
      const view = {
        activeBin: main.activeBin,
        xIsSol: main.xIsSol === true,
        flipLegs: legs
          .filter((l) => flipSet.has(l.position) && Number.isFinite(l.lowerBin) && Number.isFinite(l.upperBin))
          .map((l) => ({ lowerBin: l.lowerBin, upperBin: l.upperBin })),
        volumes: await loadVolumes(trade, p, now, fetchRecentBars),
      };

      const { reason, state } = evaluateStrategyExit({ trade, view, p, now });
      const prev = trade.strategyState ?? {};
      if ((prev.aboveSince ?? null) !== state.aboveSince || (prev.belowSince ?? null) !== state.belowSince) {
        setTradeStrategyState(trade.id, state);
      }
      if (!reason) continue;

      const detail = strategyExitDetail(reason, { trade, view, p, now, state });
      log.info(`${trade.pair} #${trade.id}: ${reason}${detail ? ` (${detail})` : ""} → close trade`);
      const res = await close(trade, { reason, detail, swap: true, positionsByAddr: live });
      if (res?.success) closed.push(trade.id);
    } catch (err) {
      log.warn(`Strategy exit #${trade.id} ${trade.pair}: ${err?.message ?? err}`);
    }
  }
  return closed;
}
