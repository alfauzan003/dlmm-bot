// Dimuat oleh `npm test` (--import) di setiap proses tes: override Telegram di settings.json
// produksi tidak boleh ikut terbaca. Tes yang mengatur SETTINGS_FILE sendiri tetap menang.
import os from "os";
import path from "path";

if (!process.env.SETTINGS_FILE) {
  process.env.SETTINGS_FILE = path.join(os.tmpdir(), `meteorabot-test-settings-${process.pid}.json`);
}
