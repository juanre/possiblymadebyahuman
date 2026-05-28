import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const zipPath = "apps/browser-extension/dist/possiblymadebyahuman-extension-0.1.0.zip";

async function packageExtension(env = {}) {
  await execFileAsync("npm", ["--workspace", "@possiblymadebyahuman/browser-extension", "run", "package"], {
    env: { ...process.env, ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("browser extension package command creates deterministic Chrome zip without source artifacts", async () => {
  await rm("apps/browser-extension/dist", { recursive: true, force: true });

  await packageExtension();
  const first = await readFile(zipPath);
  const firstHash = sha256(first);

  await packageExtension();
  const second = await readFile(zipPath);
  assert.equal(sha256(second), firstHash, "extension package should be deterministic across repeated builds");

  const entries = parseZipEntries(second);
  assert.deepEqual(entries.map((entry) => entry.name), [
    "content.js",
    "icons/128.png",
    "icons/16.png",
    "icons/48.png",
    "manifest.json",
    "popup.html",
    "popup.js",
    "service-worker.js",
  ]);

  for (const entry of entries) {
    assert.equal(entry.modifiedTime, 0, `${entry.name} should have deterministic ZIP time`);
    assert.equal(entry.modifiedDate, 0x0021, `${entry.name} should have deterministic ZIP date`);
    assert.doesNotMatch(entry.name, /\.map$|\.ts$|(^|\/)\.env(?:\.|$)|(^|\/)\.dev(?:\.|$)/);
  }

  const manifest = JSON.parse(readEntry(second, entries, "manifest.json").toString("utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.1.0");
  assert.deepEqual(manifest.permissions, ["storage", "clipboardWrite", "alarms"]);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal(manifest.background.service_worker, "service-worker.js");

  const serviceWorker = readEntry(second, entries, "service-worker.js").toString("utf8");
  assert.match(serviceWorker, /https:\/\/possiblymadebyahuman\.com/);
  assert.doesNotMatch(serviceWorker, /localhost:8787/);
});

test("browser extension build normalizes EXT_BASE_URL for configured package builds", async () => {
  await rm("apps/browser-extension/dist", { recursive: true, force: true });
  await packageExtension({ EXT_BASE_URL: "https://staging.example.test/base/path/?debug=true#frag" });
  const archive = await readFile(zipPath);
  const entries = parseZipEntries(archive);
  const serviceWorker = readEntry(archive, entries, "service-worker.js").toString("utf8");
  assert.match(serviceWorker, /https:\/\/staging\.example\.test\/base\/path\/api\/records/);
  assert.doesNotMatch(serviceWorker, /debug=true|#frag/);
});

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseZipEntries(buffer) {
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocdOffset, -1, "missing ZIP end-of-central-directory");
  const count = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "invalid central directory header");
    const modifiedTime = buffer.readUInt16LE(offset + 12);
    const modifiedDate = buffer.readUInt16LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ name, modifiedTime, modifiedDate, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer, entries, name) {
  const entry = entries.find((candidate) => candidate.name === name);
  assert.ok(entry, `missing ZIP entry ${name}`);
  const offset = entry.localHeaderOffset;
  assert.equal(buffer.readUInt32LE(offset), 0x04034b50, "invalid local file header");
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  return buffer.subarray(dataOffset, dataOffset + entry.uncompressedSize);
}
