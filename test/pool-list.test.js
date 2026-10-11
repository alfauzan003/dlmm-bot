import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import config from "../src/config/index.js";
import { parsePoolList, loadPoolList, commentPoolInList } from "../src/entry/pool-list.js";

const ADDR_A = "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt";
const ADDR_B = "7EJqZHD4TTk8B9BCjUwLtfssGbxiDAsrbFHT8YWgrE7U";

function withEntry(overrides, fn) {
  const saved = { ...config.entry };
  Object.assign(config.entry, overrides);
  try {
    return fn();
  } finally {
    Object.assign(config.entry, saved);
  }
}

test("alamat saja memakai default dari config", () => {
  withEntry({ defaultSizeSol: 0.2, defaultMaxPositions: 1 }, () => {
    const out = parsePoolList(`${ADDR_A}\n${ADDR_B}\n`);
    assert.deepEqual(out, [
      { pool: ADDR_A, sizeSol: 0.2, maxPositions: 1 },
      { pool: ADDR_B, sizeSol: 0.2, maxPositions: 1 },
    ]);
  });
});

test("alamat,size,max meng-override default", () => {
  withEntry({ defaultSizeSol: 0.2, defaultMaxPositions: 1 }, () => {
    const out = parsePoolList(`${ADDR_A},0.5,3\n`);
    assert.deepEqual(out, [{ pool: ADDR_A, sizeSol: 0.5, maxPositions: 3 }]);
  });
});

test("baris # dan kosong diabaikan", () => {
  withEntry({ defaultSizeSol: 0.2, defaultMaxPositions: 1 }, () => {
    const out = parsePoolList(`# ${ADDR_A}\n\n   #${ADDR_B}\n${ADDR_A}\n`);
    assert.deepEqual(out, [{ pool: ADDR_A, sizeSol: 0.2, maxPositions: 1 }]);
  });
});

test("alamat saja di-skip bila default size tidak valid", () => {
  withEntry({ defaultSizeSol: 0, defaultMaxPositions: 1 }, () => {
    assert.deepEqual(parsePoolList(`${ADDR_A}\n`), []);
  });
});

test("commentPoolInList menandai baris pool aktif dan idempoten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-list-"));
  const file = path.join(dir, "pool.txt");
  fs.writeFileSync(file, `# header\n${ADDR_A}\n${ADDR_B},0.5,2\n#${ADDR_A}\n`);
  const saved = config.entry.poolListFile;
  config.entry.poolListFile = file;
  try {
    assert.equal(commentPoolInList(ADDR_A), true);
    const after = fs.readFileSync(file, "utf8");
    assert.equal(after, `# header\n#${ADDR_A}\n${ADDR_B},0.5,2\n#${ADDR_A}\n`);

    assert.equal(commentPoolInList(ADDR_A), true);
    assert.equal(fs.readFileSync(file, "utf8"), after);

    assert.equal(commentPoolInList(ADDR_B), true);
    assert.equal(fs.readFileSync(file, "utf8"), `# header\n#${ADDR_A}\n#${ADDR_B},0.5,2\n#${ADDR_A}\n`);
  } finally {
    config.entry.poolListFile = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPoolList membaca dari file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-list-"));
  const file = path.join(dir, "pool.txt");
  fs.writeFileSync(file, `${ADDR_A}\n`);
  const saved = config.entry.poolListFile;
  const savedSize = config.entry.defaultSizeSol;
  config.entry.poolListFile = file;
  config.entry.defaultSizeSol = 0.2;
  try {
    assert.deepEqual(loadPoolList(), [{ pool: ADDR_A, sizeSol: 0.2, maxPositions: 1 }]);
  } finally {
    config.entry.poolListFile = saved;
    config.entry.defaultSizeSol = savedSize;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
