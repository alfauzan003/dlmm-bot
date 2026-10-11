import config from "../config/index.js";

// Delapan akun tip resmi Jito. Override lewat JITO_TIP_ACCOUNTS bila perlu.
const DEFAULT_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export function getTipAccounts() {
  const configured = config.entry.fees.jitoTipAccounts;
  return configured && configured.length > 0 ? configured : DEFAULT_TIP_ACCOUNTS;
}

export function pickTipAccount(list) {
  const accounts = list && list.length > 0 ? list : getTipAccounts();
  if (accounts.length === 0) return null;
  return accounts[Math.floor(Math.random() * accounts.length)];
}

function blockEngineUrl() {
  return `${String(config.entry.fees.jitoBlockEngineUrl).replace(/\/+$/, "")}/api/v1/bundles`;
}

// Kirim bundle (array tx base64) ke Jito block engine. Mengembalikan bundle id.
export async function sendBundle(base64Txs) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "sendBundle",
    params: [base64Txs],
  });
  const res = await fetch(blockEngineUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (json.error) {
    const msg = json.error.message || JSON.stringify(json.error);
    throw new Error(`Jito sendBundle: ${msg}`);
  }
  if (json.result == null) {
    throw new Error(`Jito sendBundle: respons tanpa result`);
  }
  return json.result;
}
