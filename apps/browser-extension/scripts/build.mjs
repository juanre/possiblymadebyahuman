#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { build, context } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const watch = process.argv.includes("--watch");
const rawBaseUrl = process.env.EXT_BASE_URL || "https://possiblymadebyahuman.com";
const normalizedBaseUrl = normalizeBaseUrl(rawBaseUrl);

const entryPoints = {
  "service-worker": join(root, "src/background/service-worker.ts"),
  content: join(root, "src/content/capture.ts"),
  popup: join(root, "src/popup/popup.ts"),
};

const sharedOptions = {
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: false,
  minify: true,
  legalComments: "none",
  logLevel: "info",
  define: {
    __PMBAH_EXT_BASE_URL__: JSON.stringify(normalizedBaseUrl),
    __PMBAH_EXT_RECORDS_ENDPOINT__: JSON.stringify(`${normalizedBaseUrl}/api/records`),
  },
};

async function buildOnce() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await Promise.all([
    build({
      ...sharedOptions,
      entryPoints,
      outdir: dist,
      entryNames: "[name]",
    }),
    copyPopupHtml(),
    writeManifest(),
    writeIcons(),
  ]);
  console.log(`Built browser extension ${packageJson.version} in ${relativeDist()}`);
}

async function watchBuild() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await copyPopupHtml();
  await writeManifest();
  await writeIcons();
  const ctx = await context({
    ...sharedOptions,
    entryPoints,
    outdir: dist,
    entryNames: "[name]",
  });
  await ctx.watch();
  console.log(`Watching browser extension sources in ${relativeDist()}`);
}

async function copyPopupHtml() {
  const html = await readFile(join(root, "src/popup/popup.html"), "utf8");
  await writeFile(join(dist, "popup.html"), html);
}

async function writeManifest() {
  const template = await readFile(join(root, "manifest.template.json"), "utf8");
  const manifest = template.replaceAll("__VERSION__", packageJson.version);
  JSON.parse(manifest);
  await writeFile(join(dist, "manifest.json"), manifest.endsWith("\n") ? manifest : `${manifest}\n`);
}

async function writeIcons() {
  const iconDir = join(dist, "icons");
  await mkdir(iconDir, { recursive: true });
  for (const size of [16, 48, 128]) {
    await writeFile(join(iconDir, `${size}.png`), makePng(size, size));
  }
}

function normalizeBaseUrl(raw) {
  const parsed = new URL(raw);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function relativeDist() {
  return "apps/browser-extension/dist";
}

function makePng(width, height) {
  const bytesPerPixel = 4;
  const rowLength = 1 + width * bytesPerPixel;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowLength;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * bytesPerPixel;
      raw[offset] = 34;
      raw[offset + 1] = 27;
      raw[offset + 2] = 23;
      raw[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.concat([uint32be(width), uint32be(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  return Buffer.concat([uint32be(data.length), typeBytes, data, uint32be(crc32(Buffer.concat([typeBytes, data])))]);
}

function uint32be(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
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

if (watch) await watchBuild();
else await buildOnce();
