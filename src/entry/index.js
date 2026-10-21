// Auto Entry: wrapper tipis di atas strategy/runner.js (screener Meteora + bid-ask flip).
import { startRunner, getScreenSnapshot } from "../strategy/runner.js";

export const startEntryScanner = startRunner;
export const getWatchSnapshot = getScreenSnapshot;

// No-op: pool.txt tidak dipakai lagi (cooldown dari trade tertutup). Pemanggil di exit/ dihapus kemudian.
export function deactivatePool(_pool, _reason) {}
