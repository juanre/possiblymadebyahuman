#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import "./build.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const zipName = `possiblymadebyahuman-extension-${packageJson.version}.zip`;
const zipPath = join(dist, zipName);
const requiredEntries = [
  "manifest.json",
  "service-worker.js",
  "content.js",
  "popup.html",
  "popup.js",
  "icons/16.png",
  "icons/48.png",
  "icons/128.png",
];
const forbiddenPatterns = [/\.map$/i, /\.ts$/i, /(^|\/)\.env(?:\.|$)/i, /(^|\/)\.dev(?:\.|$)/i];

const entries = (await listFiles(dist))
  .filter((entry) => entry !== zipName)
  .sort((left, right) => left.localeCompare(right));

for (const required of requiredEntries) {
  if (!entries.includes(required)) throw new Error(`missing extension package entry: ${required}`);
}
for (const entry of entries) {
  if (forbiddenPatterns.some((pattern) => pattern.test(entry))) {
    throw new Error(`forbidden extension package entry: ${entry}`);
  }
}

await mkdir(dist, { recursive: true });
await writeFile(zipPath, await makeZip(entries));
console.log(`Packaged ${relative(process.cwd(), zipPath)} with ${entries.length} deterministic entries`);

async function listFiles(directory, prefix = "") {
  const output = [];
  for (const dirent of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, dirent.name);
    const name = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) output.push(...(await listFiles(absolute, name)));
    else if (dirent.isFile()) output.push(name.split(sep).join("/"));
  }
  return output;
}

async function makeZip(names) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const name of names) {
    const data = await readFile(join(dist, name));
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crcTable() {
  return new Uint32Array(256).map((_, index) => {
    let c = index;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
}

function crc32(buffer) {
  const table = crcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
