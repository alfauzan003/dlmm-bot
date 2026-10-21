// Auto Entry: wrapper tipis di atas strategy/runner.js (screener Meteora + bid-ask flip).
import { startRunner, getScreenSnapshot } from "../strategy/runner.js";

export const startEntryScanner = startRunner;
export const getWatchSnapshot = getScreenSnapshot;
