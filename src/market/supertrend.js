// Supertrend calculation + touch detection.
// Ported from meteora-supertrend-alert (ATR with Wilder's smoothing).

function computeATR(candles, period) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    trs.push(tr);
  }

  if (trs.length < period) return [];

  const atr = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let prev = sum / period;
  atr.push(prev);
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    atr.push(prev);
  }
  return atr;
}

// Returns { direction: "bullish"|"bearish", line } for the last candle, or null.
export function computeSupertrend(candles, period, multiplier) {
  if (!candles || candles.length < period + 1) return null;

  const atrValues = computeATR(candles, period);
  if (atrValues.length === 0) return null;

  let direction = "bullish";
  let line = 0;

  for (let i = period; i < candles.length; i++) {
    const c = candles[i];
    const atr = atrValues[i - period];
    const mid = (c.high + c.low) / 2;
    const upperBand = mid + multiplier * atr;
    const lowerBand = mid - multiplier * atr;

    let newLine;
    let newDirection;

    if (i === period) {
      newDirection = c.close >= upperBand ? "bullish" : "bearish";
      newLine = newDirection === "bullish" ? lowerBand : upperBand;
    } else if (direction === "bullish") {
      if (c.close < line) {
        newDirection = "bearish";
        newLine = upperBand;
      } else {
        newDirection = "bullish";
        newLine = Math.max(lowerBand, line);
      }
    } else {
      if (c.close > line) {
        newDirection = "bullish";
        newLine = lowerBand;
      } else {
        newDirection = "bearish";
        newLine = Math.min(upperBand, line);
      }
    }

    line = newLine;
    direction = newDirection;
  }

  return { direction, line };
}

// Whether the (possibly still-forming) last candle touches the Supertrend line
// using its wick (high/low), so we don't wait for a close.
export function detectTouch(candle, result) {
  if (!candle || !result) {
    return { touches: false, touchType: null, direction: null, line: null };
  }

  const { direction, line } = result;
  let touches = false;
  let touchType = null;

  if (direction === "bearish") {
    if (candle.high >= line) {
      touches = true;
      touchType = "high";
    } else if (candle.close >= line) {
      touches = true;
      touchType = "close";
    }
  } else {
    if (candle.low <= line) {
      touches = true;
      touchType = "low";
    } else if (candle.close <= line) {
      touches = true;
      touchType = "close";
    }
  }

  return {
    direction,
    line,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    touches,
    touchType,
  };
}
