// Indikator untuk exit Evil Panda (murni). Setiap fungsi mengembalikan array sejajar dengan input,
// null sebelum warm-up selesai. Rumus mengikuti TradingView (ta.rsi, ta.macd, ta.bb).

const nulls = (n) => Array(n).fill(null);

// RSI Wilder: rata-rata awal = mean `length` perubahan pertama, lalu smoothing (prev*(n-1)+x)/n.
export function rsi(closes, length) {
  const out = nulls(closes.length);
  if (!(length >= 1) || closes.length <= length) return out;
  const value = (gain, loss) => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const d = closes[i] - closes[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  gain /= length;
  loss /= length;
  out[length] = value(gain, loss);
  for (let i = length + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (length - 1) + Math.max(d, 0)) / length;
    loss = (loss * (length - 1) + Math.max(-d, 0)) / length;
    out[i] = value(gain, loss);
  }
  return out;
}

// EMA dengan seed SMA; nilai null di input menggeser awal seed.
function ema(values, length) {
  const out = nulls(values.length);
  const start = values.findIndex((v) => v != null);
  if (start < 0 || values.length - start < length) return out;
  const k = 2 / (length + 1);
  let prev = 0;
  for (let i = start; i < start + length; i++) prev += values[i];
  prev /= length;
  out[start + length - 1] = prev;
  for (let i = start + length; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function macd(closes, fast, slow, signal) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => (fastEma[i] != null && slowEma[i] != null ? fastEma[i] - slowEma[i] : null));
  const sig = ema(line, signal);
  const hist = line.map((m, i) => (m != null && sig[i] != null ? m - sig[i] : null));
  return { macd: line, signal: sig, hist };
}

// SMA ± k * stdev populasi (sama dengan ta.stdev TradingView).
export function bollinger(closes, length, stdDev) {
  const middle = nulls(closes.length);
  const upper = nulls(closes.length);
  const lower = nulls(closes.length);
  for (let i = length - 1; i < closes.length; i++) {
    const win = closes.slice(i - length + 1, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / length;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / length);
    middle[i] = mean;
    upper[i] = mean + stdDev * sd;
    lower[i] = mean - stdDev * sd;
  }
  return { middle, upper, lower };
}
