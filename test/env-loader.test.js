import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { loadEnv } from "../src/config/env.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "strat-env-"));
const write = (name, content) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, content);
  return file;
};

test("strat.conf menang atas .env untuk key yang sama", () => {
  const strat = write("a.conf", "TRAILING_DROP_PCT=3\n");
  const env = write("a.env", "TRAILING_DROP_PCT=1.5\nSECRET=abc\n");
  const cfg = loadEnv(strat, env);
  assert.equal(cfg.TRAILING_DROP_PCT, "3");
  assert.equal(cfg.SECRET, "abc");
});

test("key hanya di salah satu file tetap terbaca", () => {
  const strat = write("b.conf", "ONLY_STRAT=1\n");
  const env = write("b.env", "ONLY_ENV=2\n");
  const cfg = loadEnv(strat, env);
  assert.equal(cfg.ONLY_STRAT, "1");
  assert.equal(cfg.ONLY_ENV, "2");
});

test("komentar, baris kosong, dan kutip diabaikan/dibersihkan", () => {
  const strat = write("c.conf", "# komentar\n\nNUMA=10\nSTR=\"halo dunia\"\n");
  const cfg = loadEnv(strat, write("c.env", ""));
  assert.equal(cfg.NUMA, "10");
  assert.equal(cfg.STR, "halo dunia");
  assert.equal(cfg["# komentar"], undefined);
});

test("file yang tidak ada tidak membuat error", () => {
  const missing = path.join(TMP, "tidak-ada.conf");
  const env = write("d.env", "SECRET=xyz\n");
  assert.deepEqual(loadEnv(missing, env), { SECRET: "xyz" });
  assert.deepEqual(loadEnv(missing, missing), {});
});
