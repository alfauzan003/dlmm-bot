// Indikator untuk exit Evil Panda dan ping-pong (murni). Setiap fungsi mengembalikan array sejajar dengan input,
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

// Smoothing Wilder: rata-rata awal = mean `n` nilai pertama, lalu (prev*(n-1)+x)/n.
function wilder(values, n) {
  const out = nulls(values.length);
  if (!(n >= 1) || values.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += values[i];
  out[n - 1] = s / n;
  for (let i = n; i < values.length; i++) out[i] = (out[i - 1] * (n - 1) + values[i]) / n;
  return out;
}

// True range per candle (candle pertama: high - low).
function trueRange(candles) {
  return candles.map((c, i) =>
    i === 0
      ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))
  );
}

// ATR Wilder (ta.atr). candles = [{ high, low, close }].
export function atr(candles, length) {
  return wilder(trueRange(candles || []), length);
}

// ADX Wilder (ta.adx / DMI): +DM/-DM dan TR di-smooth Wilder, DX di-smooth Wilder lagi.
export function adx(candles, length) {
  const c = candles || [];
  const tr = trueRange(c);
  const up = c.map((x, i) => (i === 0 ? 0 : x.high - c[i - 1].high));
  const down = c.map((x, i) => (i === 0 ? 0 : c[i - 1].low - x.low));
  const plus = up.map((u, i) => (u > down[i] && u > 0 ? u : 0));
  const minus = down.map((d, i) => (d > up[i] && d > 0 ? d : 0));
  const str = wilder(tr, length);
  const sp = wilder(plus, length);
  const sm = wilder(minus, length);
  const dx = [];
  const start = str.findIndex((v) => v != null);
  if (start < 0) return nulls(c.length);
  for (let i = start; i < c.length; i++) {
    const pdi = str[i] > 0 ? (100 * sp[i]) / str[i] : 0;
    const mdi = str[i] > 0 ? (100 * sm[i]) / str[i] : 0;
    dx.push(pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0);
  }
  return [...nulls(start), ...wilder(dx, length)];
}
