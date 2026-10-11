import { Connection, PublicKey } from "@solana/web3.js";
import config from "../config/index.js";

const V2_LIMIT = 1000;
const V2_MAX_PAGES = 500;

function normalizeConfig(configOrCommitment) {
  if (!configOrCommitment) return {};
  if (typeof configOrCommitment === "string") return { commitment: configOrCommitment };
  return configOrCommitment;
}

function decodeAccountData(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) {
    return Buffer.from(data[0] ?? "", "base64");
  }
  if (typeof data === "string") return Buffer.from(data, "base64");
  return Buffer.alloc(0);
}

function isMethodUnsupported(err) {
  if (!err) return false;
  if (err.code === -32601) return true;
  const msg = String(err.message || "").toLowerCase();
  return msg.includes("method not found") || msg.includes("method does not exist") || msg.includes("unsupported method");
}

// Koneksi yang mengarahkan getProgramAccounts ke getProgramAccountsV2
// (cursor-based pagination) untuk query ber-filter yang berat. Query besar
// yang sebelumnya ditolak/dideprioritaskan RPC (getProgramAccounts klasik)
// kini diambil per halaman. Fallback ke metode klasik bila V2 tak didukung.
export class PagedConnection extends Connection {
  async getProgramAccounts(programId, configOrCommitment) {
    const cfg = normalizeConfig(configOrCommitment);
    if (cfg.withContext || !Array.isArray(cfg.filters) || cfg.filters.length === 0) {
      return super.getProgramAccounts(programId, configOrCommitment);
    }
    try {
      return await this._getProgramAccountsV2(programId, cfg);
    } catch (err) {
      if (isMethodUnsupported(err)) {
        return super.getProgramAccounts(programId, configOrCommitment);
      }
      throw err;
    }
  }

  async _getProgramAccountsV2(programId, cfg) {
    const accounts = [];
    let paginationKey;
    let page = 0;
    do {
      if (page++ >= V2_MAX_PAGES) {
        throw new Error(`getProgramAccountsV2 melebihi batas ${V2_MAX_PAGES} halaman`);
      }
      const params = [
        programId.toBase58(),
        {
          encoding: "base64",
          commitment: cfg.commitment || "confirmed",
          filters: cfg.filters,
          ...(cfg.dataSlice ? { dataSlice: cfg.dataSlice } : {}),
          limit: V2_LIMIT,
          ...(paginationKey ? { paginationKey } : {}),
        },
      ];
      const res = await fetch(this.rpcEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccountsV2", params }),
      });
      const json = await res.json();
      if (json.error) {
        const err = new Error(
          typeof json.error === "string" ? json.error : json.error.message || "getProgramAccountsV2 failed"
        );
        err.code = json.error?.code;
        throw err;
      }
      const result = json.result || {};
      for (const entry of result.accounts || []) {
        accounts.push({
          pubkey: new PublicKey(entry.pubkey),
          account: { ...entry.account, data: decodeAccountData(entry.account?.data) },
        });
      }
      paginationKey = result.paginationKey || null;
    } while (paginationKey);
    return accounts;
  }
}

let _connection = null;

export function getConnection() {
  if (!_connection) {
    _connection = new PagedConnection(config.rpcUrl, { commitment: "confirmed" });
  }
  return _connection;
}
