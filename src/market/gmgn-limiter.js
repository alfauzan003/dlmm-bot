import config from "../config/index.js";
import log from "../core/logger.js";
import { sleep } from "../core/utils.js";

// Antrean terpusat untuk SEMUA panggilan GMGN.
// - laju dibatasi maxPerMin (rolling 60s window)
// - jarak minimum antar panggilan minGapMs
// - saat 429/ban: pause sampai reset, dan (opsional) turunkan cap otomatis
// - dedup in-flight per key: pemanggil bersamaan berbagi hasil yang sama
export function createGmgnLimiter({ maxPerMin = 4, minGapMs = 15000 } = {}) {
  const stamps = [];
  const queue = [];
  const inflight = new Map();
  let draining = false;
  let blockedUntil = 0;
  let currentCap = Math.max(1, Number(maxPerMin) || 1);
  let totalCalls = 0;
  let totalRateLimited = 0;

  function prune(now) {
    const cutoff = now - 60000;
    while (stamps.length && stamps[0] <= cutoff) stamps.shift();
  }

  function nextAllowedAt(now = Date.now()) {
    let t = Math.max(now, blockedUntil);
    prune(t);
    if (stamps.length >= currentCap) {
      const idx = stamps.length - currentCap;
      t = Math.max(t, stamps[idx] + 60000);
    }
    const last = stamps[stamps.length - 1] || 0;
    if (last && minGapMs > 0) t = Math.max(t, last + minGapMs);
    return t;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const wait = nextAllowedAt() - Date.now();
        if (wait > 0) await sleep(wait);
        const task = queue.shift();
        if (!task) continue;
        stamps.push(Date.now());
        totalCalls++;
        try {
          task.resolve(await task.fn());
        } catch (err) {
          task.reject(err);
        } finally {
          if (task.key) inflight.delete(task.key);
        }
      }
    } finally {
      draining = false;
    }
  }

  function schedule(key, fn) {
    if (key && inflight.has(key)) return inflight.get(key);
    let resolve;
    let reject;
    const p = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    if (key) inflight.set(key, p);
    queue.push({ key, fn, resolve, reject });
    drain();
    return p;
  }

  // Pause karena 429/ban. Adaptive: turunkan cap agar makin aman.
  function blockFor(ms, { adaptive = true } = {}) {
    const pause = Math.max(1000, Number(ms) || 0);
    blockedUntil = Math.max(blockedUntil, Date.now() + pause);
    totalRateLimited++;
    if (adaptive && currentCap > 1) {
      currentCap = Math.max(1, Math.floor(currentCap / 2));
      log.warn(`GMGN limiter: rate-limit/ban — cap turun ke ${currentCap}/menit, pause ${Math.ceil(pause / 1000)}s`);
    } else {
      log.warn(`GMGN limiter: pause ${Math.ceil(pause / 1000)}s`);
    }
  }

  function stats() {
    prune(Date.now());
    return {
      queue: queue.length,
      callsLastMin: stamps.length,
      cap: currentCap,
      totalCalls,
      totalRateLimited,
      blockedForMs: Math.max(0, blockedUntil - Date.now()),
    };
  }

  return {
    schedule,
    blockFor,
    stats,
    isBlocked: () => Date.now() < blockedUntil,
    nextAllowedAt,
  };
}

const gmgnLimiter = createGmgnLimiter({
  maxPerMin: config.gmgnMaxPerMin,
  minGapMs: Math.max(0, Number(config.gmgnMinGapSec) || 0) * 1000,
});

export default gmgnLimiter;
