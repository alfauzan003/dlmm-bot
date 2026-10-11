// Pembatas kecepatan sederhana (sliding window 60s) + saklar cooldown untuk 429.
export function makeLimiter(maxPerMin) {
  const stamps = [];
  let blockedUntil = 0;
  return {
    isBlocked: () => Date.now() < blockedUntil,
    tryAcquire() {
      if (Date.now() < blockedUntil) return false;
      const cutoff = Date.now() - 60_000;
      while (stamps.length && stamps[0] < cutoff) stamps.shift();
      if (stamps.length >= maxPerMin) return false;
      stamps.push(Date.now());
      return true;
    },
    blockFor(ms) {
      blockedUntil = Math.max(blockedUntil, Date.now() + Math.max(0, ms));
    },
  };
}
