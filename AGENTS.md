# AGENTS.md

## Aturan Kerja (WAJIB)

1. Ubah SEMINIMAL mungkin. Jangan refactor atau "perbaiki sekalian" yang tidak diminta.
2. Kalau ragu atau perlu mengubah lebih banyak, tanyakan dulu.

## Keamanan runtime (penting)

- `npm start` benar-benar konek ke Solana RPC/Helius, Jupiter, GMGN, dan **bisa mengirim transaksi trading**. Selalu uji dengan `DRY_RUN=true` di `.env` dulu.
- Jangan jalankan bot sambil mengedit file state produksi (`state.json`, `pool.txt`, `settings.json`, dll) — bisa bentrok.
- Bot Telegram hanya menjawab chat **private** dengan id `TELEGRAM_CHAT_ID`. `/wallet` export/import menangani private key — jangan pernah menulis kunci ke log, error, atau output tes.
