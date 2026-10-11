import { bool, num } from "./env.js";

export const RULE_DEFAULTS = {
  enableStopLoss: false,
  stopLossPct: -90,
  enableOOR: false,
  oorKiriMinutes: 60,
  // OOR kanan: 0 = tutup langsung; >0 = masa tunggu (menit) sebelum tutup,
  // batal bila harga kembali masuk range.
  oorKananMinutes: 0,
  enableIndicators: false,
  // Warmup exit (menit): trailing & arm indikator ditahan selama ini sejak
  // posisi pertama terlihat. Stop loss/OOR/yield tetap jalan. 0 = nonaktif.
  exitWarmupMinutes: 0,
  rsiPeriod: 2,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  bbPeriod: 20,
  bbStddev: 2,
  trailingTakeProfit: false,
  trailingTriggerPct: 10,
  // Drop trailing = max(reference * ratio, floor). Rasio adaptif untuk peak
  // besar, floor menjaga agar peak rendah tidak exit karena noise.
  trailingDropRatioPct: 8,
  trailingDropPct: 1.5,
  enableBounceRecovery: false,
  bounceRecoveryTrigger: -40,
  bounceRecoveryTarget: -10,
  bounceRecoveryTrailingPct: 2,
  // Yield rendah: 0 = nonaktif. >0 = tutup (setelah delay) bila posisi
  // in-range, yield <= nilai ini, dan PnL >= 0.
  lowYieldClosePct: 0,
  lowYieldDelayMinutes: 10,
};

export function modeRules(e, prefix, overrides = {}) {
  const d = { ...RULE_DEFAULTS, ...overrides };
  const k = (name) => `${prefix}_${name}`;
  return {
    enableStopLoss: bool(e[k("ENABLE_STOP_LOSS")], d.enableStopLoss),
    stopLossPct: num(e[k("STOP_LOSS_PCT")], d.stopLossPct),
    enableOOR: bool(e[k("ENABLE_OOR")], d.enableOOR),
    oorKiriMinutes: num(e[k("OOR_KIRI_MINUTES")], d.oorKiriMinutes),
    oorKananMinutes: Math.max(0, num(e[k("OOR_KANAN_MINUTES")], d.oorKananMinutes)),
    enableIndicators: bool(e[k("ENABLE_INDICATORS")], d.enableIndicators),
    exitWarmupMinutes: Math.max(0, num(e[k("EXIT_WARMUP_MINUTES")], d.exitWarmupMinutes)),
    rsiPeriod: num(e[k("RSI_PERIOD")], d.rsiPeriod),
    macdFast: num(e[k("MACD_FAST")], d.macdFast),
    macdSlow: num(e[k("MACD_SLOW")], d.macdSlow),
    macdSignal: num(e[k("MACD_SIGNAL")], d.macdSignal),
    bbPeriod: num(e[k("BB_PERIOD")], d.bbPeriod),
    bbStddev: num(e[k("BB_STDDEV")], d.bbStddev),
    trailingTakeProfit: bool(e[k("TRAILING_TAKE_PROFIT")], d.trailingTakeProfit),
    trailingTriggerPct: num(e[k("TRAILING_TRIGGER_PCT")], d.trailingTriggerPct),
    trailingDropRatioPct: num(e[k("TRAILING_DROP_RATIO_PCT")], d.trailingDropRatioPct),
    trailingDropPct: num(e[k("TRAILING_DROP_PCT")], d.trailingDropPct),
    enableBounceRecovery: bool(e[k("ENABLE_BOUNCE_RECOVERY")], d.enableBounceRecovery),
    bounceRecoveryTrigger: num(e[k("BOUNCE_RECOVERY_TRIGGER")], d.bounceRecoveryTrigger),
    bounceRecoveryTarget: num(e[k("BOUNCE_RECOVERY_TARGET")], d.bounceRecoveryTarget),
    bounceRecoveryTrailingPct: num(e[k("BOUNCE_RECOVERY_TRAILING_PCT")], d.bounceRecoveryTrailingPct),
    lowYieldClosePct: Math.max(0, num(e[k("LOW_YIELD_CLOSE_PCT")], d.lowYieldClosePct)),
    lowYieldDelayMinutes: Math.max(0, num(e[k("LOW_YIELD_DELAY_MINUTES")], d.lowYieldDelayMinutes)),
  };
}

// Pemetaan mode lama (state.json sebelumnya) -> mode composite baru.
export const LEGACY_MODE = {
  bidask: "bidask:double",
  "token-only": "bidask:token",
  "sol-only": "bidask:sol",
  spot: "spot",
  "spot:double": "spot",
  "spot:token": "spot",
  "spot:sol": "spot",
};
