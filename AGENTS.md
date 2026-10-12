# AGENTS.md

## Aturan Kerja (WAJIB)

1. Ubah SEMINIMAL mungkin. Jangan refactor atau "perbaiki sekalian" yang tidak diminta.
2. Kalau ragu atau perlu mengubah lebih banyak, tanyakan dulu.
3. Sebelum bilang "selesai": jelaskan file yang diubah + dampaknya, lalu jalankan `git status` dan `git diff --stat` dan tunjukkan hasilnya.

## Keamanan runtime (penting)

- `npm start` benar-benar konek ke Solana RPC/Helius, Jupiter, GMGN, dan **bisa mengirim transaksi trading**. Selalu uji dengan `DRY_RUN=true` di `.env` dulu.
- Jangan jalankan bot sambil mengedit file state produksi (`state.json`, `pool.txt`, `settings.json`, dll) — bisa bentrok.
- Bot Telegram hanya menjawab chat **private** dengan id `TELEGRAM_CHAT_ID`. `/wallet` export/import menangani private key — jangan pernah menulis kunci ke log, error, atau output tes.

## Jebakan repo

- **`npm install` menjalankan `postinstall`** (`scripts/patch-anchor.js`) yang mem-patch `@coral-xyz/anchor` + `@meteora-ag/dlmm` untuk ESM Node 24. Ganti/update dependency → jalankan `npm install` ulang, jika tidak bot gagal import.
- **Bot menulis ke `pool.txt`**: mengomentari (`#`) pool yang sudah selesai. Jangan biarkan `pool.txt` terbuka di editor saat bot jalan (save akan menimpa mark bot).
- File state runtime **git-ignored** dan tidak boleh di-commit: `state.json`, `settings.json`, `wallet.key`, `pool.txt`, `decision-log.json`, `pnl-history.json`, `supertrend-cache.json`, `logs/`, `.env`.
- **Default strategi ada di `strat.conf`** (di-commit). Tuning dilakukan di sini lalu `git commit`, bukan di `.env`. Bila key sama, `strat.conf` **menang** atas `.env` (`loadEnv` di `src/config/env.js`). `SOL_MODE=false` → PnL dalam USD. Override dari Telegram (`/settings` → 🧩 Strategy) disimpan di `settings.json` → `stratOverrides` dan **menang** atas `strat.conf` (prioritas `.env` < `strat.conf` < `stratOverrides`); tes otomatis memakai `SETTINGS_FILE` sementara lewat `test/setup-env.js`.
- **Toggle di `settings.json`** (dibuat saat start pertama: Auto Exit ON; Auto-entry, Deterministic exit OFF) diubah lewat `/settings` dan jadi **satu-satunya** saklar on/off fitur tersebut (tidak ada `ENTRY_ENABLED` di `strat.conf`).
- Tes memakai override env (`STATE_FILE`, `DECISION_LOG_FILE`, `PNL_HISTORY_FILE`, `SETTINGS_FILE`, `WALLET_KEY_FILE`) supaya tidak menyentuh file produksi — ikuti pola ini untuk tes baru.
- `test/smoke.test.js` mengimpor semua modul; kalau pindah/ganti nama file, update daftar `MODULES` di file itu.
- `scripts/pnl-report.js` **read-only** — tidak menyentuh `state.json`, tidak mengirim transaksi.
- Rahasia & setelan instance (wallet, RPC, API key, telegram, `DRY_RUN`) ada di `.env` (jangan pernah di-commit; `chmod 600 .env`). Pengecualian: wallet hasil import Telegram disimpan di `wallet.key` dan **menimpa** `WALLET_PRIVATE_KEY`.

## Alur domain singkat

- **Asisten Telegram** (`src/tg/`): `/start`, `/open`, `/positions`, `/pnl`, `/wallet`, `/settings`, `/help` (grammY). Aksi on-chain tanpa kode Telegram ada di `src/lp/` (buka, claim, tutup trade).
- **Trade** (`state.json` → `trades`, `src/state/trades.js`): 1..N posisi on-chain dihitung sebagai satu trade (satu PnL, satu close) dengan TP/SL/Trail sendiri. Loop exit (`src/exit/index.js` + `trade-loop.js`) menjalankan TP/SL/Trail untuk semua trade; aturan lama di bawah hanya jalan bila toggle-nya ON.

- **Entry**: Supertrend 15m native (GMGN) bullish + harga real-time Jupiter ≤ garis → masuk (`first_touch`). Bearish = pool tidak dipantau. Dua cadence terpisah (refresh kandidat vs poll harga Jupiter).
- **Exit**: per mode `bidask:<komposit>` (`bidask:double`, `bidask:token`, `bidask:sol`) atau `spot` (satu mode, berapa pun jumlah bin; `/open` memakai shape pilihan, posisi luar dideteksi dari likuiditas rata per bin; OOR kanan ber-timer) — stop loss, OOR, trailing TP, dll. OOR kiri `spot` → tutup tanpa swap lalu buka posisi `bidask:token` satu-sisi (jual saat naik) di pool yang sama; token dilindungi dari sweep selama proses (`spot-fallback.js`, `open-token-position.js`). Yield rendah `spot` (in-range, yield ≤ `SPOT_LOW_YIELD_CLOSE_PCT`, PnL ≥ 0, bertahan `SPOT_LOW_YIELD_DELAY_MINUTES`) → close + swap.
