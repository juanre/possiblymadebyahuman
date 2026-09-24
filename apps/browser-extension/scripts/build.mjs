#!/usr/bin/env node
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = process.env.EXT_DIST_DIR && process.env.EXT_DIST_DIR.trim().length > 0
  ? process.env.EXT_DIST_DIR
  : join(root, "dist");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const watch = process.argv.includes("--watch");
const rawBaseUrl = process.env.EXT_BASE_URL || "https://possiblymadebyahuman.com";
const normalizedBaseUrl = normalizeBaseUrl(rawBaseUrl);

// The service worker is declared "type": "module" and the popup loads its
// script as a module, so both may be ESM bundles. Manifest content_scripts run
// as classic scripts, so the content bundle must be a self-contained IIFE.
const moduleEntryPoints = {
  "service-worker": join(root, "src/background/service-worker.ts"),
  popup: join(root, "src/popup/popup.ts"),
};
const contentEntryPoints = {
  content: join(root, "src/content/capture.ts"),
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
    __PMBAH_EXT_VERSION__: JSON.stringify(packageJson.version),
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
      entryPoints: moduleEntryPoints,
      outdir: dist,
      entryNames: "[name]",
    }),
    build({
      ...sharedOptions,
      format: "iife",
      entryPoints: contentEntryPoints,
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
  const moduleContext = await context({
    ...sharedOptions,
    entryPoints: moduleEntryPoints,
    outdir: dist,
    entryNames: "[name]",
  });
  const contentContext = await context({
    ...sharedOptions,
    format: "iife",
    entryPoints: contentEntryPoints,
    outdir: dist,
    entryNames: "[name]",
  });
  await Promise.all([moduleContext.watch(), contentContext.watch()]);
  console.log(`Watching browser extension sources in ${relativeDist()}`);
}

async function copyPopupHtml() {
  const html = await readFile(join(root, "src/popup/popup.html"), "utf8");
  await writeFile(join(dist, "popup.html"), html);
  await copyFile(join(root, "../site/static/favicon.svg"), join(dist, "favicon.svg"));
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
    await copyFile(join(root, "icons", `${size}.png`), join(iconDir, `${size}.png`));
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

if (watch) await watchBuild();
else await buildOnce();
