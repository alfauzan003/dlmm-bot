import fs from "fs";
import { PNL_HISTORY_FILE } from "../core/paths.js";
import { readJsonArray } from "./store.js";

export function recordPnlSnapshot(positionAddress, pair, pnlPct, marketCap, feePct24h, volumeData) {
  if (!positionAddress || pnlPct == null) return;
  const history = readJsonArray(PNL_HISTORY_FILE);
  history.push({
    t: Date.now(),
    pos: positionAddress,
    pair: pair || "",
    pnl: pnlPct,
    mc: marketCap ?? null,
    fee: feePct24h ?? null,
    vol: volumeData?.vol ?? null,
    volAvg5: volumeData?.volAvg5 ?? null,
  });
  fs.writeFileSync(PNL_HISTORY_FILE, JSON.stringify(history));
}
