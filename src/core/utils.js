export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function minutes(m) {
  return m * 60 * 1000;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
