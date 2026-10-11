export function computeRSI(closes, period = 2) {
  if (!closes || closes.length < period + 1) return [];

  const gains = [];
  const losses = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  const rsi = [];
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  if (avgLoss === 0) {
    rsi.push(100);
  } else {
    const rs = avgGain / avgLoss;
    rsi.push(100 - 100 / (1 + rs));
  }

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    if (avgLoss === 0) {
      rsi.push(100);
    } else {
      const rs = avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
  }

  return rsi;
}

export function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (!closes || closes.length < slow + signal) {
    return { macd: [], signal: [], histogram: [], macdGreen: false };
  }

  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);

  // EMA fast & slow punya panjang berbeda (fast lebih panjang). Sejajarkan
  // dari ujung (nilai terakhir = close terakhir) sebelum dikurangkan.
  const fastOffset = emaFast.length - emaSlow.length;
  const macdLine = emaSlow.map((v, i) => emaFast[i + fastOffset] - v);

  const signalLine = EMA(macdLine, signal);

  // signalLine lebih pendek dari macdLine; sejajarkan dari ujung juga.
  const signalOffset = macdLine.length - signalLine.length;
  const macdAligned = macdLine.slice(signalOffset);
  const histogram = macdAligned.map((v, i) => v - signalLine[i]);

  const histogramLatest = histogram[histogram.length - 1];
  const macdGreen = histogramLatest > 0;

  return {
    macd: macdAligned,
    signal: signalLine,
    histogram,
    macdLatest: macdAligned[macdAligned.length - 1],
    signalLatest: signalLine[signalLine.length - 1],
    histogramLatest,
    macdGreen,
  };
}

export function computeBB(closes, period = 20, stddev = 2) {
  if (!closes || closes.length < period) {
    return { upper: null, middle: null, lower: null };
  }

  const slice = closes.slice(-period);
  const middle = SMA(slice, period);
  const std = standardDeviation(slice, middle);

  return {
    upper: middle + stddev * std,
    middle,
    lower: middle - stddev * std,
  };
}

function SMA(values, period) {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function EMA(values, period) {
  const k = 2 / (period + 1);
  const result = [];
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * k + ema;
    result.push(ema);
  }

  return result;
}

function standardDeviation(values, mean) {
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
}
