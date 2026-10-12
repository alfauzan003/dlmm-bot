import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { ROOT } from "../src/core/paths.js";

// Tidak mengatur SETTINGS_FILE sendiri: membuktikan test/setup-env.js (npm test) melakukannya.
test("npm test points SETTINGS_FILE away from the production settings.json", () => {
  assert.ok(process.env.SETTINGS_FILE);
  assert.notEqual(path.resolve(process.env.SETTINGS_FILE), path.resolve(ROOT, "settings.json"));
});
