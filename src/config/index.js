import { loadEnv, bool, num } from "./env.js";

const FEE_MODES = ["none", "priority", "jito", "both"];
function normalizeFeeMode(raw) {
  const value = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase();
  return FEE_MODES.includes(value) ? value : "none";
}

// Entry execution is fixed by design: BidAsk, two-sided (token + SOL), bins ±34.
export const BINS_BELOW = 34;
export const BINS_ABOVE = 34;
export const STRATEGY = "bid_ask";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Seluruh config dari satu peta env (lihat loadEnv: .env < strat.conf < override Telegram).
export function buildConfig(e) {
  const entry = {
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
    stAtrPeriod: num(e.ST_ATR_PERIOD, 10),
    stMultiplier: num(e.ST_MULTIPLIER, 3),
    expiryHours: num(e.ENTRY_EXPIRY_HOURS, 6),
    sizeSplit: num(e.ENTRY_SIZE_SPLIT, 0.5),
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
    maxFailures: num(e.ENTRY_MAX_FAILURES, 3),
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
      (e.HELIUS_API_KEY
        ? `https://rpc.helius.xyz/?api-key=${e.HELIUS_API_KEY}`
        : "https://api.mainnet-beta.solana.com"),
    heliusApiKey: e.HELIUS_API_KEY || "",
    gmgnApiKey: e.GMGN_API_KEY || "",
    jupiterPriceApiKey: e.JUPITER_PRICE_API_KEY || e.JUPITER_API_KEY || "",
    jupiterSwapApiKey: e.JUPITER_SWAP_API_KEY || e.JUPITER_API_KEY || "",
    dryRun: e.DRY_RUN !== "false",
    solMode: e.SOL_MODE !== "false",
    // info (default) = naratif + warn/error; debug = ikut menampilkan [detail] teknis.
    logLevel: (e.LOG_LEVEL || "info").toLowerCase() === "debug" ? "debug" : "info",

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

    pollIntervalHold: num(e.POLL_INTERVAL_HOLD, 0.2),
    pollIntervalIdle: num(e.POLL_INTERVAL_IDLE, 5),
    // Interval loop TP/SL/Trail per trade (detik), terpisah dari loop exit utama.
    tradeExitIntervalSec: Math.max(1, num(e.TRADE_EXIT_INTERVAL_SEC, 1)),
    // Jumlah siklus berturut-turut posisi tidak terbaca on-chain sebelum
    // dianggap sudah ditutup manual.
    missingCycleThreshold: Math.max(1, num(e.MISSING_CYCLE_THRESHOLD, 5)),

    telegramBotToken: e.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: e.TELEGRAM_CHAT_ID || "",
    tgStatusInterval: num(e.TG_STATUS_INTERVAL, 5),

    // Exit Evil Panda per trade (lihat src/exit/evil-panda.js).
    evilPanda: {
      defaultOn: bool(e.EVIL_PANDA_DEFAULT_ON, false),
      stAtrPeriod: Math.max(1, Math.floor(num(e.EVIL_PANDA_ST_ATR_PERIOD, 10))),
      stMultiplier: num(e.EVIL_PANDA_ST_MULTIPLIER, 3),
      rsi: {
        on: bool(e.EVIL_PANDA_RSI, true),
        length: Math.max(1, Math.floor(num(e.EVIL_PANDA_RSI_LENGTH, 2))),
        level: num(e.EVIL_PANDA_RSI_LEVEL, 90),
      },
      macd: {
        on: bool(e.EVIL_PANDA_MACD, false),
        fast: Math.max(1, Math.floor(num(e.EVIL_PANDA_MACD_FAST, 12))),
        slow: Math.max(1, Math.floor(num(e.EVIL_PANDA_MACD_SLOW, 26))),
        signal: Math.max(1, Math.floor(num(e.EVIL_PANDA_MACD_SIGNAL, 9))),
      },
      bb: {
        on: bool(e.EVIL_PANDA_BB, false),
        length: Math.max(2, Math.floor(num(e.EVIL_PANDA_BB_LENGTH, 20))),
        stdDev: num(e.EVIL_PANDA_BB_STDDEV, 2),
      },
    },

    entry,
    swap,
  };

  return config;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Timpa isi target dengan source; objek bersarang diperbarui di tempat agar referensi
// yang dipegang modul lain (mis. config.entry.fees) tetap melihat nilai baru.
function assignDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) assignDeep(target[key], value);
    else target[key] = value;
  }
}

const config = buildConfig(loadEnv());

// Bangun ulang dari file (dipanggil setelah override Telegram berubah). Gagal build = config lama tetap.
export function reloadConfig() {
  const next = buildConfig(loadEnv());
  assignDeep(config, next);
  return config;
}

export default config;
