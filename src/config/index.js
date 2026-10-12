import { loadEnv, bool, num } from "./env.js";
import { modeRules, LEGACY_MODE } from "./rules.js";

const e = loadEnv();

const FEE_MODES = ["none", "priority", "jito", "both"];
function normalizeFeeMode(raw) {
  const value = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase();
  return FEE_MODES.includes(value) ? value : "none";
}

// Mode = "<strategi>:<komposisi>".
//   bidask : bidask:double | bidask:token | bidask:sol
//   spot   : spot (satu mode, tanpa komposisi; span >= SPOT_MIN_BINS)
const bidaskDouble = modeRules(e, "BIDASK_DOUBLE", {
  enableIndicators: true,
  trailingTakeProfit: true,
});

// Token-only: trailing TP OFF, indikator + trailing-dari-sinyal ON.
// Dipakai juga oleh fallback OOR kiri spot (posisi token-only hasil konversi).
const bidaskToken = modeRules(e, "BIDASK_TOKEN", {
  enableIndicators: true,
  trailingTakeProfit: false,
});

const bidaskSol = modeRules(e, "BIDASK_SOL", {
  enableIndicators: true,
  trailingTakeProfit: true,
});

// Spot-quote (satu mode, isi SOL-only, span >= SPOT_MIN_BINS): indikator sama
// seperti bidask:double, trailing TP trigger +20%, OOR kanan ber-timer 5 menit.
// OOR kiri = tutup langsung (0 menit), lalu token dikonversi ke posisi
// bidask:token oleh fallback (lihat spotFallback).
const spot = modeRules(e, "SPOT", {
  enableIndicators: true,
  // Tahan trailing & arm indikator 30 menit pertama (2 candle 15m) agar posisi
  // yang dibuka di puncak tidak langsung kena trailing.
  exitWarmupMinutes: 30,
  trailingTakeProfit: true,
  trailingTriggerPct: 20,
  enableOOR: true,
  oorKiriMinutes: 0,
  oorKananMinutes: 5,
  lowYieldClosePct: 6,
  lowYieldDelayMinutes: 10,
});

// Fallback OOR kiri spot: tutup tanpa swap, lalu buka posisi token-only
// satu-sisi di pool yang sama memakai seluruh saldo token.
const spotFallback = {
  enabled: bool(e.SPOT_FALLBACK_ENABLED, true),
  binsAbove: Math.max(0, Math.floor(num(e.SPOT_FALLBACK_BINS_ABOVE, 70))),
  binsBelow: Math.max(0, Math.floor(num(e.SPOT_FALLBACK_BINS_BELOW, 0))),
  retry: Math.max(1, Math.floor(num(e.SPOT_FALLBACK_RETRY, 3))),
  distribution: (e.SPOT_FALLBACK_DISTRIBUTION || "bid_ask").toLowerCase(),
};

// Re-entry spot saat OOR kanan: buka posisi spot SOL-only baru di harga aktif
// dengan jumlah bin ke bawah sama seperti posisi yang barusan ditutup.
const spotReentry = {
  enabled: bool(e.SPOT_REENTRY_ENABLED, false),
  sizeSol: Math.max(0, num(e.SPOT_REENTRY_SIZE_SOL, 0)),
  maxReentries: Math.max(0, Math.floor(num(e.SPOT_REENTRY_MAX, 10))),
  // Tolak re-entry bila akan kena biaya non-refundable (sewa bin array/bitmap).
  skipNonRefundable: bool(e.SPOT_REENTRY_SKIP_NONREFUNDABLE, true),
  maxNonRefundableSol: Math.max(0, num(e.SPOT_REENTRY_MAX_NONREFUNDABLE_SOL, 0)),
};

const entry = {
  enabled: bool(e.ENTRY_ENABLED, true),
  poolListFile: e.POOL_LIST_FILE || "pool.txt",
  // Default untuk baris pool.txt yang hanya berisi alamat (tanpa ,size,max).
  defaultSizeSol: num(e.ENTRY_DEFAULT_SIZE_SOL, 0),
  defaultMaxPositions: Math.max(1, Math.floor(num(e.ENTRY_DEFAULT_MAX_POSITION, 1))),
  // Kuota posisi `bidask:double` milik bot yang boleh terbuka serentak di satu
  // pool. Posisi mode lain (mis. spot manual) tidak dihitung, jadi tidak
  // memblokir entry.
  maxConcurrentBidaskDouble: Math.max(1, Math.floor(num(e.ENTRY_MAX_CONCURRENT_BIDASK_DOUBLE, 1))),
  // Refresh kandidat (pool list + posisi terbuka via RPC), bukan cadence sinyal.
  scanIntervalSec: num(e.ENTRY_SCAN_INTERVAL_SEC, 30),
  timeframe: e.ENTRY_TIMEFRAME || "15m",
  stAtrPeriod: num(e.ST_ATR_PERIOD, 10),
  stMultiplier: num(e.ST_MULTIPLIER, 3),
  expiryHours: num(e.ENTRY_EXPIRY_HOURS, 6),
  sizeSplit: num(e.ENTRY_SIZE_SPLIT, 0.5),
  // Slippage initialize position (basis poin) — dipakai sebagai acuan lama.
  slippageBps: num(e.ENTRY_SLIPPAGE_BPS, 1000),
  // Slippage aktif bin untuk add-liquidity, dalam PERSEN (SDK memakai persen,
  // bukan basis poin). Menghasilkan maxActiveBinSlippage = ceil(pct / binStep%).
  activeBinSlippagePct: Math.max(0, num(e.ENTRY_ACTIVE_BIN_SLIPPAGE_PCT, 10)),
  // Rem harga: batalkan entry kalau harga aktif pool menyimpang dari harga
  // pasar (Jupiter) melebihi ambang ini. Gagal ambil harga = lanjut (fail-open).
  poolPriceCheck: bool(e.ENTRY_POOL_PRICE_CHECK, true),
  maxPoolPriceDeviationPct: Math.max(0, num(e.ENTRY_MAX_POOL_PRICE_DEVIATION_PCT, 15)),
  // Saat deviasi di atas ambang, coba ulang (baca ulang harga tiap percobaan).
  poolPriceMaxAttempts: Math.max(1, Math.floor(num(e.ENTRY_POOL_PRICE_MAX_ATTEMPTS, 3))),
  poolPriceRetryDelaySec: Math.max(0, num(e.ENTRY_POOL_PRICE_RETRY_DELAY_SEC, 10)),
  gasReserve: num(e.GAS_RESERVE, 0.05),
  failureCooldownSec: num(e.ENTRY_FAILURE_COOLDOWN_SEC, 300),
  oneShotPerSignal: bool(e.ENTRY_ONE_SHOT_PER_SIGNAL, true),
  maxFailures: num(e.ENTRY_MAX_FAILURES, 3),
  // held_pullback = close harus tetap di atas garis; first_touch = sentuh garis = entry.
  touchMode: (e.ENTRY_TOUCH_MODE || "held_pullback").toLowerCase() === "first_touch" ? "first_touch" : "held_pullback",
  // Strategi fee entry. none = perilaku lama + retry; priority = ComputeBudget;
  // jito = tip Jito; both = keduanya. Lihat src/solana/{fees,send,jito}.js.
  fees: {
    mode: normalizeFeeMode(e.ENTRY_FEE_MODE),
    priorityMicroLamports: Math.max(0, num(e.ENTRY_PRIORITY_FEE_MICRO_LAMPORTS, 50000)),
    computeUnitLimit: Math.max(0, num(e.ENTRY_COMPUTE_UNIT_LIMIT, 0)),
    jitoTipSol: Math.max(0, num(e.ENTRY_JITO_TIP_SOL, 0.001)),
    maxSol: Math.max(0, num(e.ENTRY_FEE_MAX_SOL, 0.002)),
    retryAttempts: Math.max(1, Math.floor(num(e.ENTRY_TX_RETRY_ATTEMPTS, 5))),
    confirmTimeoutSec: Math.max(1, num(e.ENTRY_TX_CONFIRM_TIMEOUT_SEC, 30)),
    resendIntervalMs: Math.max(200, num(e.ENTRY_TX_RESEND_INTERVAL_MS, 2000)),
    dualSend: bool(e.ENTRY_DUAL_SEND, true),
    jitoBlockEngineUrl: e.JITO_BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf",
    jitoTipAccounts:
      e.JITO_TIP_ACCOUNTS != null && e.JITO_TIP_ACCOUNTS !== ""
        ? e.JITO_TIP_ACCOUNTS.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
  },
};

// Entry execution is fixed by design: BidAsk, two-sided (token + SOL), bins ±34.
export const BINS_BELOW = 34;
export const BINS_ABOVE = 34;
export const STRATEGY = "bid_ask";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const swap = {
  autoSwapAfterClose: bool(e.AUTO_SWAP_AFTER_CLOSE, true),
  slippageBps: num(e.SWAP_SLIPPAGE_BPS, 100),
  // true = Jupiter RTSE (estimasi slippage otomatis, mode ultra); false =
  // pakai SWAP_SLIPPAGE_BPS tetap.
  useRtse: bool(e.SWAP_USE_RTSE, false),
  retryAttempts: num(e.SWAP_RETRY_ATTEMPTS, 3),
  dustUsdThreshold: num(e.DUST_USD_THRESHOLD, 0.5),
  excludeMints:
    e.SWEEP_EXCLUDE_MINTS != null && e.SWEEP_EXCLUDE_MINTS !== ""
      ? e.SWEEP_EXCLUDE_MINTS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [USDC_MINT],
  failureCooldownSec: num(e.SWEEP_FAILURE_COOLDOWN_SEC, 1800),
};

const config = {
  walletPrivateKey: e.WALLET_PRIVATE_KEY || "",
  rpcUrl:
    e.RPC_URL ||
    (e.HELIUS_API_KEY ? `https://rpc.helius.xyz/?api-key=${e.HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com"),
  heliusApiKey: e.HELIUS_API_KEY || "",
  gmgnApiKey: e.GMGN_API_KEY || "",
  jupiterPriceApiKey: e.JUPITER_PRICE_API_KEY || e.JUPITER_API_KEY || "",
  jupiterSwapApiKey: e.JUPITER_SWAP_API_KEY || e.JUPITER_API_KEY || "",
  dryRun: e.DRY_RUN !== "false",
  solMode: e.SOL_MODE !== "false",
  // info (default) = naratif + warn/error; debug = ikut menampilkan [detail] teknis.
  logLevel: (e.LOG_LEVEL || "info").toLowerCase() === "debug" ? "debug" : "info",

  timeframe: e.TIMEFRAME || "15m",

  volumeCandleCount: num(e.VOLUME_CANDLE_COUNT, 5),
  volumeTimeframe: e.VOLUME_TIMEFRAME || "5m",

  // Data layer: TF native pakai Meteora; 15m (non-native) pakai GMGN.
  candleCacheTtlSec: num(e.CANDLE_CACHE_TTL_SEC, 60),
  // Jeda (detik) setelah bar 15m tutup sebelum request data baru, agar bar
  // baru sudah terbentuk dan bar yang baru tutup sudah final.
  candleCloseDelaySec: Math.max(0, num(e.CANDLE_CLOSE_DELAY_SEC, 3)),
  candle15mSource: (e.CANDLE_15M_SOURCE || "gmgn").toLowerCase() === "meteora" ? "meteora" : "gmgn",
  gmgnMaxPerMin: num(e.GMGN_MAX_PER_MIN, 4),
  gmgnMinGapSec: num(e.GMGN_MIN_GAP_SEC, 15),
  gmgnMaxStaleMin: num(e.GMGN_MAX_STALE_MIN, 30),
  gmgnFallbackToMeteora: bool(e.GMGN_FALLBACK_TO_METEORA, false),
  meteoraMaxPerMin: num(e.METEORA_MAX_PER_MIN, 120),

  // Sinyal entry: GMGN 15m (arah+garis) + Jupiter (harga real-time).
  // Satu request batch untuk semua pool. Limit price/v3 ≈ 10 req/10s (~1 req/s);
  // pakai key khusus harga + interval 2s (≈5 req/10s) agar aman dari 429.
  jupiterPollIntervalSec: Math.max(1, num(e.JUPITER_POLL_INTERVAL_SEC, 2)),
  entryTouchTolerancePct: num(e.ENTRY_TOUCH_TOLERANCE_PCT, 0),
  supertrendCacheFile: e.SUPERTREND_CACHE_FILE || "supertrend-cache.json",

  logRetentionDays: num(e.LOG_RETENTION_DAYS, 7),

  // Ambang span bin minimum untuk mengenali posisi spot-quote.
  spotMinBins: Math.max(1, Math.floor(num(e.SPOT_MIN_BINS, 200))),
  pollIntervalHold: num(e.POLL_INTERVAL_HOLD, 0.2),
  pollIntervalIdle: num(e.POLL_INTERVAL_IDLE, 5),
  // Interval loop TP/SL/Trail per trade (detik), terpisah dari loop exit utama.
  tradeExitIntervalSec: Math.max(1, num(e.TRADE_EXIT_INTERVAL_SEC, 1)),
  trailingConfirmDelaySec: num(e.TRAILING_CONFIRM_DELAY_SEC, 10),
  // Jumlah siklus berturut-turut posisi tidak terbaca on-chain sebelum
  // dianggap sudah ditutup manual.
  missingCycleThreshold: Math.max(1, num(e.MISSING_CYCLE_THRESHOLD, 5)),

  telegramBotToken: e.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: e.TELEGRAM_CHAT_ID || "",
  tgStatusInterval: num(e.TG_STATUS_INTERVAL, 5),

  entry,
  swap,
  spotFallback,
  spotReentry,

  bidaskDouble,
  bidaskToken,
  bidaskSol,
  spot,

  rulesFor(mode) {
    switch (LEGACY_MODE[mode] || mode) {
      case "bidask:token":
        return this.bidaskToken;
      case "bidask:sol":
        return this.bidaskSol;
      case "spot":
        return this.spot;
      case "bidask:double":
      default:
        return this.bidaskDouble;
    }
  },
};

export default config;
