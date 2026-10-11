import test from "node:test";
import assert from "node:assert/strict";

const MODULES = [
  "../src/config/index.js",
  "../src/config/env.js",
  "../src/config/rules.js",
  "../src/core/constants.js",
  "../src/core/logger.js",
  "../src/core/paths.js",
  "../src/core/rate-limiter.js",
  "../src/core/utils.js",
  "../src/state/store.js",
  "../src/state/positions.js",
  "../src/state/trailing.js",
  "../src/state/bounce.js",
  "../src/state/dca.js",
  "../src/state/history.js",
  "../src/solana/connection.js",
  "../src/solana/wallet.js",
  "../src/solana/balances.js",
  "../src/solana/swap.js",
  "../src/solana/fees.js",
  "../src/solana/jito.js",
  "../src/solana/send.js",
  "../src/market/candles.js",
  "../src/market/gmgn-client.js",
  "../src/market/gmgn-limiter.js",
  "../src/market/jupiter-price.js",
  "../src/market/supertrend-state.js",
  "../src/market/indicators.js",
  "../src/market/supertrend.js",
  "../src/meteora/sdk.js",
  "../src/meteora/positions.js",
  "../src/meteora/close.js",
  "../src/meteora/open-token-position.js",
  "../src/notify/telegram.js",
  "../src/entry/index.js",
  "../src/entry/runtime.js",
  "../src/entry/pool-list.js",
  "../src/entry/pool-info.js",
  "../src/entry/price-watch.js",
  "../src/entry/execute.js",
  "../src/entry/dca.js",
  "../src/exit/index.js",
  "../src/exit/rules.js",
  "../src/exit/classify.js",
  "../src/exit/trailing.js",
  "../src/exit/bounce.js",
  "../src/exit/sweep.js",
  "../src/exit/close.js",
  "../src/exit/spot-fallback.js",
  "../src/exit/spot-reentry.js",
];

test("every module loads without import errors", async () => {
  for (const path of MODULES) {
    const loaded = await import(path);
    assert.ok(loaded, `${path} should load`);
    assert.ok(Object.keys(loaded).length > 0, `${path} should export something`);
  }
});
