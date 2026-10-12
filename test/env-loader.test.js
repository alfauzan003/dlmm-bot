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
  const strat = write("c.conf", '# komentar\n\nNUMA=10\nSTR="halo dunia"\n');
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

test("stratOverrides menang atas strat.conf, hanya untuk key yang ada di strat.conf", () => {
  const strat = write("o.conf", "A=1\nB=2\n");
  const env = write("o.env", "A=0\nSECRET=s\n");
  const settings = write("o.json", JSON.stringify({ stratOverrides: { A: "9", SECRET: "x", GONE: "1", B: 5 } }));
  const cfg = loadEnv(strat, env, settings);
  assert.equal(cfg.A, "9");
  assert.equal(cfg.B, "2"); // non-string diabaikan
  assert.equal(cfg.SECRET, "s"); // key khusus .env tidak bisa di-override
  assert.equal(cfg.GONE, undefined);
});

test("settings.json rusak atau tidak ada = tanpa override", () => {
  const strat = write("p.conf", "A=1\n");
  assert.equal(loadEnv(strat, write("p.env", ""), write("p.json", "{oops")).A, "1");
  assert.equal(loadEnv(strat, write("q.env", ""), path.join(TMP, "none.json")).A, "1");
});
