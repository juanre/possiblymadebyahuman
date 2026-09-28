// Generates Chrome Web Store screenshots and the promo tile from the real
// extension. The listing's screenshots in store-assets/screenshots are captured
// by hand in Gmail; this writes its own set to store-assets/generated-screenshots. It builds the extension against a local ingest service backed by
// an in-memory store, drives it in Chromium on a fictional blog page, and
// composes each page next to the extension panel the way Chrome's side panel
// sits next to a tab. Nothing is sent to production.
//
//   node scripts/store-screenshots.mjs
//
// PMBAH_SCREENSHOT_PORT selects the local service port (default 4730).
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createIngestApi } from "../apps/ingest-api/src/index.ts";
import { createRuntimeServer } from "../apps/ingest-api/src/server.ts";
import { InMemoryRecordStore } from "../packages/storage/src/index.ts";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const assetsDir = join(rootDir, "apps/browser-extension/store-assets");
const screenshotsDir = join(assetsDir, "generated-screenshots");
const port = Number(process.env.PMBAH_SCREENSHOT_PORT ?? 4730);
const serviceUrl = `http://127.0.0.1:${port}`;
const PUBLIC_BASE_URL = "https://possiblymadebyahuman.com";

const STORE = { width: 1280, height: 800 };
const PANEL = { width: 400, height: STORE.height };
const TAB = { width: STORE.width - PANEL.width, height: STORE.height };

// A fictional newsletter. The reply is typed with a couple of corrections so
// the record shows ordinary editing rather than a single insertion.
const BLOG_URL = "https://allotmentletter.example.com/2026/09/why-tomatoes-split/";
const REPLY_STEPS = [
  { type: "Same thing happend" },
  { back: 3 },
  { type: "ened to ours in August. We watered deeply every evening, then a week of heavy rain undid it overnight." },
  { pause: 4200 },
  { type: " This year I am mulching earlier and watering less but more regularly." },
  { pause: 2600 },
  { type: " So far only two have split, both on the plant nearest the dwonpipe" },
  { back: 7 },
  { type: "ownpipe." },
];

const BLOG_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Why tomatoes split after rain · The Allotment Letter</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 17px/1.6 Georgia, 'Iowan Old Style', serif; color: #2b2a26; background: #f7f5ef; }
  header { background: #2f4a33; color: #f7f5ef; padding: 18px 40px; display: flex; justify-content: space-between; align-items: baseline; }
  header strong { font-size: 22px; letter-spacing: .5px; }
  header nav { font: 14px system-ui, sans-serif; opacity: .85; }
  header nav span { margin-left: 18px; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 40px 48px; }
  h1 { font-size: 34px; line-height: 1.2; margin: 0 0 6px; }
  .byline { font: 14px system-ui, sans-serif; color: #6b675c; margin-bottom: 22px; }
  p { margin: 0 0 14px; }
  h2 { font-size: 21px; margin: 30px 0 12px; border-top: 1px solid #dcd6c6; padding-top: 22px; }
  label { display: block; font: 600 14px system-ui, sans-serif; margin: 12px 0 6px; }
  input, textarea { width: 100%; font: 16px/1.5 system-ui, sans-serif; padding: 10px 12px; border: 1px solid #b9b2a0; border-radius: 6px; background: #fff; color: #2b2a26; }
  textarea { height: 170px; resize: vertical; }
  textarea:focus, input:focus { outline: 2px solid #3f6b46; outline-offset: 1px; }
  button { margin-top: 12px; font: 600 15px system-ui, sans-serif; background: #2f4a33; color: #fff; border: 0; border-radius: 6px; padding: 10px 18px; }
</style></head>
<body>
<header><strong>The Allotment Letter</strong><nav><span>Seasons</span><span>Beds &amp; soil</span><span>Archive</span></nav></header>
<main>
  <h1>Why tomatoes split after rain</h1>
  <div class="byline">From the September letter</div>
  <p>A dry spell followed by a downpour is the classic cause. The fruit's skin has stopped stretching, the roots suddenly take up more water than the skin can accommodate, and the tomato cracks along its shoulders.</p>
  <p>Even watering matters more than generous watering. How have your plants fared this season?</p>
  <h2>Leave a reply</h2>
  <label for="name">Name</label>
  <input id="name" value="Sam R." />
  <label for="reply">Your reply</label>
  <textarea id="reply" spellcheck="false"></textarea>
  <button type="button">Post reply</button>
</main>
</body></html>`;

function run(command, args, env = {}) {
  execFileSync(command, args, { cwd: rootDir, stdio: "inherit", env: { ...process.env, ...env } });
}

async function startService(siteDistDir) {
  const store = new InMemoryRecordStore();
  const api = createIngestApi({ store, baseUrl: PUBLIC_BASE_URL });
  // Readiness is not used here; the runtime server only needs a queryable.
  const db = { query: async () => ({ rows: [] }) };
  const server = createRuntimeServer({ api, store, db, webDistDir: join(rootDir, "apps/web/dist"), siteDistDir });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}

// Deterministic, uneven keystroke gaps: quicker within words, slower at
// spaces and sentence ends, so the record page shows a plausible rhythm.
function gaps(seed = 7) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
}

async function typeReply(page) {
  const random = gaps();
  for (const step of REPLY_STEPS) {
    for (const char of step.type ?? "") {
      await page.keyboard.type(char);
      const extra = char === "." ? 900 + random() * 1600 : char === " " ? random() * 350 : 0;
      await page.waitForTimeout(70 + random() * 170 + extra);
    }
    for (let i = 0; i < (step.back ?? 0); i += 1) { await page.keyboard.press("Backspace"); await page.waitForTimeout(110 + random() * 90); }
    if (step.pause) await page.waitForTimeout(step.pause);
  }
}

// Places a page screenshot and a panel screenshot side by side, separated the
// way Chrome separates its side panel from the tab.
async function composeWithPanel(composer, tabPng, panelPng, file) {
  await composer.setViewportSize(STORE);
  await composer.setContent(`<!doctype html><html><body style="margin:0;display:flex;width:${STORE.width}px;height:${STORE.height}px;overflow:hidden;background:#fff">
    <img src="data:image/png;base64,${tabPng.toString("base64")}" width="${TAB.width}" height="${TAB.height}" style="display:block">
    <img src="data:image/png;base64,${panelPng.toString("base64")}" width="${PANEL.width - 1}" height="${PANEL.height}" style="display:block;border-left:1px solid #c7c7c7">
  </body></html>`);
  await composer.screenshot({ path: join(screenshotsDir, file) });
}

async function promoTile(composer) {
  const figure = await readFile(join(rootDir, "apps/site/static/images/post-llm-600.png"));
  await composer.setViewportSize({ width: 440, height: 280 });
  await composer.setContent(`<!doctype html><html><body style="margin:0;width:440px;height:280px;overflow:hidden;background:#fbf8f2;
      background-image:linear-gradient(rgba(139,94,52,.085) 1px,transparent 1px),linear-gradient(90deg,rgba(139,94,52,.085) 1px,transparent 1px);background-size:22px 22px;
      font-family:'Iowan Old Style','New York',Georgia,serif;color:#202124;display:flex;align-items:center">
    <img src="data:image/png;base64,${figure.toString("base64")}" style="height:250px;margin:0 4px 0 14px;mix-blend-mode:multiply">
    <div style="padding-right:22px">
      <div style="font:600 13px Inter,system-ui,sans-serif;letter-spacing:.4px;color:#62594e;margin-bottom:10px">possiblymadebyahuman</div>
      <div style="font-size:25px;font-weight:600;line-height:1.15;letter-spacing:-.3px">We cannot prove a human wrote it.</div>
      <div style="font-size:16px;font-style:italic;color:#3d2f17;margin-top:12px;line-height:1.3">But we can record the writing process, and sign it for you.</div>
    </div>
  </body></html>`);
  await composer.screenshot({ path: join(assetsDir, "promo-tile-440x280.png") });
}

async function main() {
  await mkdir(screenshotsDir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "pmbah-store-screenshots-"));
  const distDir = join(work, "extension");
  const siteDistDir = join(work, "site");
  run(process.execPath, [join(rootDir, "apps/browser-extension/scripts/build.mjs")], { EXT_BASE_URL: serviceUrl, EXT_DIST_DIR: distDir });
  run("npm", ["run", "build:web"]);
  run("hugo", ["--quiet", "--source", join(rootDir, "apps/site"), "--destination", siteDistDir]);
  const server = await startService(siteDistDir);
  const context = await chromium.launchPersistentContext(join(work, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    await context.route(BLOG_URL, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: BLOG_HTML }));

    const tab = await context.newPage();
    await tab.setViewportSize(TAB);
    await tab.goto(BLOG_URL);

    // Chrome renders the side panel outside any tab, which headless Chromium
    // cannot show. The same panel document runs in a background tab of the
    // same window, so "This editor" still follows the blog tab. It refreshes
    // only while visible, which a side panel always is.
    const panel = await context.newPage();
    await panel.setViewportSize(PANEL);
    await panel.addInitScript(() => Object.defineProperty(document, "visibilityState", { get: () => "visible" }));
    await panel.goto(`chrome-extension://${extensionId}/popup.html`);

    await tab.bringToFront();
    await tab.locator("#reply").click();
    await panel.evaluate(() => document.getElementById("start").click());
    await panel.locator("#toast").filter({ hasText: "Writing record started" }).waitFor();
    await typeReply(tab);
    await panel.evaluate(() => { const toast = document.getElementById("toast"); toast.textContent = ""; toast.hidden = true; });
    await panel.locator("#current article").filter({ hasText: "editing events" }).waitFor();
    await panel.waitForTimeout(1200);
    const composer = await context.newPage();
    await tab.bringToFront();
    await composeWithPanel(composer, await tab.screenshot(), await panel.screenshot(), "1-recording.png");

    await panel.getByRole("button", { name: "Finish & get link" }).first().click();
    await panel.locator(".binding-scope").filter({ hasText: /Whole field|Selected text/ }).waitFor();
    await tab.bringToFront();
    await composeWithPanel(composer, await tab.screenshot(), await panel.screenshot(), "2-review.png");

    await panel.locator(".sign-confirm-go").click();
    const saved = panel.locator("#latest");
    await saved.getByRole("heading", { name: "Record saved" }).waitFor({ timeout: 30_000 });
    await panel.waitForTimeout(600);
    const recordUrl = await saved.getByLabel("Complete record link").inputValue();
    await tab.bringToFront();
    await composeWithPanel(composer, await tab.screenshot(), await panel.screenshot(), "3-published.png");

    const record = await context.newPage();
    await record.setViewportSize(STORE);
    await record.goto(`${serviceUrl}${new URL(recordUrl).pathname}`);
    await record.waitForLoadState("networkidle");
    await record.waitForTimeout(800);
    await record.screenshot({ path: join(screenshotsDir, "4-record.png") });

    await record.getByRole("heading", { name: "Edit timeline" }).evaluate(heading => window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 12));
    await record.waitForTimeout(300);
    await record.screenshot({ path: join(screenshotsDir, "5-timeline.png") });
    await promoTile(composer);
    console.log(`Wrote screenshots to ${screenshotsDir} for ${recordUrl}`);
  } finally {
    await context.close();
    server.close();
    await rm(work, { recursive: true, force: true });
  }
}

await main();
