// Filter kandidat untuk price-watch loop (murni, tanpa I/O) — mudah diuji.
// `inFlight`/`entered` bisa Set atau Map (cukup punya .has).
export function selectWatchCandidates(candidates, { inFlight, entered, cooldowns, now = Date.now() } = {}) {
  const inFlightSet = inFlight || new Set();
  const enteredSet = entered || new Set();
  const cooldownMap = cooldowns || new Map();

  return (candidates || []).filter((c) => {
    if (!c?.pool || !c?.mint) return false;
    if (inFlightSet.has(c.pool)) return false;
    if (enteredSet.has(c.pool)) return false;
    const until = cooldownMap.get(c.pool) || 0;
    if (now < until) return false;
    return true;
  });
}
