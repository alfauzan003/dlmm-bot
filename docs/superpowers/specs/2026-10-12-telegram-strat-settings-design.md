# Telegram: edit semua setelan strat.conf — Design

## Tujuan

Pengguna bisa melihat dan mengubah **setiap key di `strat.conf`** dari Telegram (`/settings` → 🧩 Strategy),
tanpa SSH, tanpa edit file, dan sebagian besar tanpa restart. `strat.conf` tetap jadi default yang di-commit.

Keputusan pengguna (2026-10-12):

- Perubahan dari Telegram disimpan sebagai **override per-instance di `settings.json`** (git-ignored), bukan
  menulis ulang `strat.conf`. Ada reset per key dan reset semua.
- Key yang hanya dibaca saat start **tetap bisa diedit**, ditandai ⟳ dan berlaku setelah restart.
- Daftar key, bagian menu, teks bantuan, dan tipe dibangun **otomatis dari `strat.conf`** + tabel kecil untuk
  yang tidak bisa ditebak (pendekatan 1).

## Di luar cakupan

- Key yang hanya ada di `.env` (wallet, RPC, API key, Telegram, `DRY_RUN`) tidak pernah tampil atau bisa diedit.
- Menulis ke `strat.conf` atau commit dari bot.
- Membuat key ⟳ berlaku live (reschedule loop/limiter).
- Toggle, exit defaults, range/deposit presets, auto flip yang sudah ada di `/settings` tidak berubah.

## Prioritas nilai

`.env` < `strat.conf` < `settings.json.stratOverrides`

- `stratOverrides` = objek `{ KEY: "nilai string" }`, disimpan sebagai string agar diproses parser yang sama
  dengan `strat.conf` (`bool`, `num`, split koma).
- Hanya key yang ada di `strat.conf` yang dipakai dari `stratOverrides`; key lain diabaikan (mis. sisa key yang
  sudah dihapus dari `strat.conf`).
- Loader config membaca `stratOverrides` langsung dari `SETTINGS_FILE` (JSON mentah), **tidak** meng-import
  `src/state/settings.js`, supaya tidak ada import siklik config ↔ state.

## Komponen

### 1. `src/config/strat-schema.js` (baru)

Parser + skema, murni (tanpa efek samping selain baca file):

- `parseStratFile(text)` → `{ sections: [{ title, keys: [KEY…] }], entries: { KEY: { key, default, help,
  section } } }`.
  - Bagian = baris `# ===== Judul =====`. Key sebelum header pertama masuk bagian "Umum".
  - `help` = blok komentar `#` tepat di atas key (baris kosong memutus blok).
  - `default` = nilai di `strat.conf` (string).
- Tipe per key: `bool` bila default `true`/`false`; `number` bila default angka; selain itu `string`.
  Tabel `OVERRIDES` menimpa/menambah: `enum` (`ENTRY_FEE_MODE`: none/priority/jito/both, `LOG_LEVEL`: debug/info/
  warn/error, `CANDLE_15M_SOURCE`, `TIMEFRAME`, `VOLUME_TIMEFRAME`), `list` (`SWEEP_EXCLUDE_MINTS`,
  `JITO_TIP_ACCOUNTS`: daftar dipisah koma, boleh kosong), dan `min`/`max` untuk key yang punya batas jelas
  (mis. `ENTRY_SIZE_SPLIT` 0–1, persen 0–100, interval > 0).
- `RESTART_KEYS` = key yang ditangkap saat start (ditentukan saat implementasi dengan memeriksa pemakaian
  modul-level / sekali di `src/index.js`; minimal `TRADE_EXIT_INTERVAL_SEC`, `ENTRY_SCAN_INTERVAL_SEC`,
  `JUPITER_POLL_INTERVAL_SEC`, `LOG_LEVEL`, `LOG_RETENTION_DAYS`, `METEORA_MAX_PER_MIN`).
- `validateValue(key, raw)` → `{ ok: true, value: "string ternormalisasi" }` atau `{ ok: false, error }`.
  Angka harus finite dan dalam min/max; bool hanya true/false; enum harus salah satu pilihan; list dinormalkan
  (trim, buang kosong).

### 2. `src/config/index.js` (refactor kecil)

- Isi sekarang dibungkus jadi `buildConfig(e)`; `const config = buildConfig(loadStratEnv())` tetap jadi default
  export (objek yang sama untuk semua modul).
- `loadStratEnv()` = `loadEnv()` + `stratOverrides` yang valid (key ada di `strat.conf`).
- `reloadConfig()` membangun ulang config lalu menimpa **isi** objek `config` yang ada secara rekursif
  (objek bersarang seperti `config.entry.fees` diperbarui di tempat, bukan diganti), sehingga modul yang
  memegang referensi ikut melihat nilai baru. Fungsi (`rulesFor`) tetap.

### 3. `src/state/settings.js`

- `withDefaults` mempertahankan `stratOverrides` (objek string→string; selain itu dibuang).
- `getStratOverrides()`, `setStratOverride(key, value)` (validasi via `validateValue`, lalu `reloadConfig()`),
  `clearStratOverride(key)`, `clearStratOverrides()` (keduanya juga `reloadConfig()`).

### 4. `src/tg/strat-settings.js` (baru) + tombol di `src/tg/settings.js`

Callback prefix `st:` (data ≤ 64 byte; nama key terpanjang 37 karakter).

- `/settings` dapat tombol **🧩 Strategy** → `st:home`.
- **Home**: daftar bagian (jumlah override per bagian bila ada), **↩ Reset all overrides** (`st:resetall`, minta
  konfirmasi dua langkah), ◀ Back ke `/settings`.
- **Bagian** `st:s:<i>:<page>`: 8 key per halaman, label `KEY = nilai` + `✏️` bila di-override, `⟳` bila restart;
  ◀ / ▶ halaman, ◀ Back.
- **Kartu key** `st:k:<KEY>`: nilai efektif, default `strat.conf`, teks bantuan, catatan ⟳ bila perlu.
  - bool → tombol toggle langsung (`st:set:<KEY>:true|false`).
  - enum → satu tombol per pilihan.
  - number/string/list → **✏️ Edit** menyimpan prompt `{ kind: "strat-edit", key }`; pesan teks berikutnya
    divalidasi. Gagal → pesan error, prompt tetap aktif. List kosong dikirim sebagai `-`.
  - **↩ Reset to default** (`st:reset:<KEY>`) bila di-override.
  - Setelah simpan: kartu diperbarui; key ⟳ menampilkan "Saved — applies after restart".
- Setiap perubahan dicatat ke log (`log.info`) dengan key, nilai lama → baru (tidak ada rahasia di `strat.conf`).

## Error handling

- Nilai tidak valid tidak pernah ditulis; pesan menyebut tipe/batas yang diharapkan.
- `settings.json` rusak → perilaku lama (`withDefaults`) berlaku; `stratOverrides` kosong.
- Gagal `reloadConfig()` (exception saat build) → override tidak disimpan, config lama tetap, error dilaporkan.

## Tes

Semua memakai `STRAT_FILE` / `SETTINGS_FILE` sementara (pola AGENTS.md).

- `parseStratFile`: bagian, komentar bantuan, tipe tebakan, key sebelum header pertama.
- `validateValue`: bool, number + min/max, enum, list, string.
- Loader: override menang atas `strat.conf`, override key tak dikenal diabaikan.
- `reloadConfig`: nilai bersarang berubah di objek yang sama (`config.entry.fees` identitas tetap).
- `settings.js`: set/clear/clear-all, `withDefaults` mempertahankan `stratOverrides`.
- Telegram: home → bagian → halaman, toggle bool, pilih enum, edit angka valid/invalid lewat prompt, reset,
  reset all, label ✏️/⟳.
- Smoke test: modul baru masuk daftar `MODULES`.

## Dokumentasi

README (bagian Settings) dan AGENTS.md (jebakan: prioritas `.env` < `strat.conf` < `stratOverrides`, override
ada di `settings.json`) diperbarui.
