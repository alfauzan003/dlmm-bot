// Exit strategi Auto Entry: trade auto ditutup saat cycle_done / pumped_away / range_broken /
// volume_died / max_hold (evaluator murni di strategy/exits.js). Jalan tiap siklus loop exit utama,
// terlepas dari toggle Auto Entry. Parameter = snapshot saat entry (trade.strategy.params).
import log from "../core/logger.js";
import { closeTrade as defaultCloseTrade } from "../lp/close-trade.js";
import { fetchCandles as defaultFetchCandles } from "../market/candles.js";
import { getTrackedPosition } from "../state/positions.js";
import { listOpenTrades, setTradeStrategyState, tradeLock } from "../state/trades.js";
import { evaluateStrategyExit } from "../strategy/exits.js";
import { closedBars } from "../strategy/screen.js";

const isLegClosed = (addr) => getTrackedPosition(addr)?.closed === true;

// Volume 5m bar yang sudah tutup; gagal fetch → [] (tidak pernah melempar).
async function loadVolumes(trade, leg, p, now, fetchCandles) {
  if (!(p.lowVolumeBars > 0)) return [];
  try {
    const candles = await fetchCandles(leg.baseMint ?? trade.baseMint, leg.pool ?? trade.pool, {
      resolution: "5m",
      limit: p.lowVolumeBars + 2,
    });
    return Array.isArray(candles) ? closedBars(candles, now).map((c) => c.volume) : [];
  } catch {
    return [];
  }
}

// Satu siklus: evaluasi tiap trade auto terbuka; mengembalikan id trade yang berhasil ditutup.
export async function runStrategyExits(positions, { deps = {}, now = Date.now() } = {}) {
  const close = deps.closeTrade ?? defaultCloseTrade;
  const fetchCandles = deps.fetchCandles ?? defaultFetchCandles;
  const live = new Map((positions || []).filter((p) => p?.position).map((p) => [p.position, p]));
  const closed = [];

  for (const trade of listOpenTrades()) {
    if (!trade.strategy?.params || tradeLock(trade.id)) continue;
    try {
      const legs = (trade.positions || []).filter((addr) => !isLegClosed(addr)).map((addr) => live.get(addr)).filter(Boolean);
      if (legs.length === 0) continue;
      const flipSet = new Set(trade.flipLegs || []);
      const main = legs.find((l) => !flipSet.has(l.position)) ?? legs[0];
      const p = trade.strategy.params;
      const view = {
        activeBin: main.activeBin,
        xIsSol: main.xIsSol === true,
        flipLegs: legs.filter((l) => flipSet.has(l.position)).map((l) => ({ lowerBin: l.lowerBin, upperBin: l.upperBin })),
        volumes: await loadVolumes(trade, main, p, now, fetchCandles),
      };

      const { reason, state } = evaluateStrategyExit({ trade, view, p, now });
      const prev = trade.strategyState ?? {};
      if ((prev.aboveSince ?? null) !== state.aboveSince || (prev.belowSince ?? null) !== state.belowSince) {
        setTradeStrategyState(trade.id, state);
      }
      if (!reason) continue;

      log.info(`${trade.pair} #${trade.id}: ${reason} → close trade`);
      const res = await close(trade, { reason, swap: true, positionsByAddr: live });
      if (res?.success) closed.push(trade.id);
    } catch (err) {
      log.warn(`Strategy exit #${trade.id} ${trade.pair}: ${err?.message ?? err}`);
    }
  }
  return closed;
}
