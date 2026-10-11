# AGENTS.md

## Aturan Kerja (WAJIB)

1. Ubah SEMINIMAL mungkin. Jangan refactor atau "perbaiki sekalian" yang tidak diminta.
2. Kalau ragu atau perlu mengubah lebih banyak, tanyakan dulu.
3. Sebelum bilang "selesai": jelaskan file yang diubah + dampaknya, lalu jalankan `git status` dan `git diff --stat` dan tunjukkan hasilnya.
4. Jangan commit tanpa izin. Setelah hasil disetujui, baru tawarkan commit dengan pesan sederhana.

## Keamanan runtime (penting)

- `npm start` benar-benar konek ke Solana RPC/Helius, Jupiter, GMGN, dan **bisa mengirim transaksi trading**. Selalu uji dengan `DRY_RUN=true` di `.env` dulu.
- Jangan jalankan bot sambil mengedit file state produksi (`state.json`, `pool.txt`, dll) — bisa bentrok.

## Jebakan repo

- **`npm install` menjalankan `postinstall`** (`scripts/patch-anchor.js`) yang mem-patch `@coral-xyz/anchor` + `@meteora-ag/dlmm` untuk ESM Node 24. Ganti/update dependency → jalankan `npm install` ulang, jika tidak bot gagal import.
- **Bot menulis ke `pool.txt`**: mengomentari (`#`) pool yang sudah selesai. Jangan biarkan `pool.txt` terbuka di editor saat bot jalan (save akan menimpa mark bot).
- File state runtime **git-ignored** dan tidak boleh di-commit: `state.json`, `pool.txt`, `decision-log.json`, `pnl-history.json`, `supertrend-cache.json`, `logs/`, `.env`.
- **Default strategi ada di `strat.conf`** (di-commit). Tuning dilakukan di sini lalu `git commit`, bukan di `.env`. Bila key sama, `strat.conf` **menang** atas `.env` (`loadEnv` di `src/config/env.js`).
- Tes memakai override env (`STATE_FILE`, `DECISION_LOG_FILE`, `PNL_HISTORY_FILE`) supaya tidak menyentuh file produksi — ikuti pola ini untuk tes baru.
- `test/smoke.test.js` mengimpor semua modul; kalau pindah/ganti nama file, update daftar `MODULES` di file itu.
- `scripts/pnl-report.js` **read-only** — tidak menyentuh `state.json`, tidak mengirim transaksi.
- Rahasia & setelan instance (wallet, RPC, API key, telegram, `DRY_RUN`) ada di `.env` (jangan pernah di-commit; `chmod 600 .env`).

## Alur domain singkat

- **Entry**: Supertrend 15m native (GMGN) bullish + harga real-time Jupiter ≤ garis → masuk (`first_touch`). Bearish = pool tidak dipantau. Dua cadence terpisah (refresh kandidat vs poll harga Jupiter).
- **Exit**: per mode `bidask:<komposit>` (`bidask:double`, `bidask:token`, `bidask:sol`) atau `spot` (satu mode, span ≥ `SPOT_MIN_BINS`, OOR kanan ber-timer) — stop loss, OOR, trailing TP, dll. OOR kiri `spot` → tutup tanpa swap lalu buka posisi `bidask:token` satu-sisi (jual saat naik) di pool yang sama; token dilindungi dari sweep selama proses (`spot-fallback.js`, `open-token-position.js`). Yield rendah `spot` (in-range, yield ≤ `SPOT_LOW_YIELD_CLOSE_PCT`, PnL ≥ 0, bertahan `SPOT_LOW_YIELD_DELAY_MINUTES`) → close + swap.
- **DCA**: averaging-down saat PnL sentuh `DCA_ARM_PCT`, rebound dari trough, dibatasi per sesi (`state.dcaUsage`). Hanya mode di `DCA_ELIGIBLE_MODES` (default `bidask:double`); `spot` & `bidask:token` dikecualikan.
