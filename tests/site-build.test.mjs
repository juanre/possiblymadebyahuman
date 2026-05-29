import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hugoAvailable = spawnSync("hugo", ["version"], { stdio: "ignore" }).status === 0;

test("hugo builds landing + docs with content-blind copy and no plaintext fixture leak", { skip: !hugoAvailable ? "hugo binary not available" : undefined }, () => {
  const out = mkdtempSync(join(tmpdir(), "pmbah-site-"));
  try {
    const build = spawnSync(
      "hugo",
      ["--source", "apps/site", "--destination", out, "--minify"],
      { encoding: "utf8" },
    );
    assert.equal(build.status, 0, `hugo build failed: ${build.stderr || build.stdout}`);

    const expected = [
      "index.html",
      "docs/index.html",
      "docs/product-promise/index.html",
      "docs/claims/index.html",
      "docs/privacy/index.html",
      "docs/records/index.html",
      "docs/verification/index.html",
      "docs/threat-model/index.html",
      "docs/conformance/index.html",
      "docs/routing/index.html",
      "docs/server-observed-commitments/index.html",
      "docs/write/index.html",
      "docs/terms/index.html",
      "docs/emacs/index.html",
    ];

    for (const relative of expected) {
      const path = join(out, relative);
      const body = readFileSync(path, "utf8");
      assert.ok(body.length > 0, `${relative} is empty`);
      assert.ok(body.includes("possiblymadebyahuman"), `${relative} missing product name`);
      assert.ok(body.includes("content-blind"), `${relative} missing content-blind framing`);
    }

    assert.ok(!existsSync(join(out, "blog/index.html")), "blog/ should not be built");

    for (const asset of [
      "images/pmbah-figure-1200.webp",
      "images/pmbah-figure-1200.jpg",
      "images/pmbah-figure-600.webp",
      "images/pmbah-figure-600.jpg",
      "favicon.svg",
      "favicon.ico",
      "favicon-32.png",
      "apple-touch-icon.png",
      "icon-192.png",
      "icon-512.png",
      "site.webmanifest",
      "robots.txt",
      "sitemap.xml",
      "og/card.jpg",
    ]) {
      assert.ok(existsSync(join(out, asset)), `${asset} missing from build output`);
    }

    const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
    assert.ok(sitemap.includes("https://possiblymadebyahuman.com/"), "sitemap missing absolute URLs");
    assert.ok(sitemap.includes("https://possiblymadebyahuman.com/docs/emacs/"), "sitemap missing /docs/emacs/");
    assert.ok(sitemap.includes("https://possiblymadebyahuman.com/docs/privacy/"), "sitemap missing /docs/privacy/");
    assert.ok(sitemap.includes("https://possiblymadebyahuman.com/docs/terms/"), "sitemap missing /docs/terms/");

    const robots = readFileSync(join(out, "robots.txt"), "utf8");
    assert.ok(robots.includes("Sitemap: https://possiblymadebyahuman.com/sitemap.xml"), "robots.txt missing Sitemap directive");
    assert.ok(robots.includes("Disallow: /api/"), "robots.txt missing /api/ Disallow");

    const manifest = JSON.parse(readFileSync(join(out, "site.webmanifest"), "utf8"));
    assert.equal(manifest.name, "possiblymadebyahuman");
    assert.equal(manifest.theme_color, "#fbf8f2");
    assert.ok(manifest.icons.length >= 2, "manifest must declare icon set");

    const home = readFileSync(join(out, "index.html"), "utf8");
    assert.ok(home.includes("We cannot prove a human wrote it"), "home missing the headline");
    assert.ok(home.includes("But we can record the writing process"), "home missing the H2 counter-claim");
    assert.ok(home.includes("home-figure"), "home missing the hand-drawn figure block");
    assert.ok(home.includes("/images/pmbah-figure"), "home missing the figure asset reference");
    assert.ok(home.includes("href=/write"), "home missing /write CTA");
    assert.ok(home.includes("href=/docs/emacs/"), "home missing /emacs/ CTA");
    assert.ok(home.includes("href=/docs/"), "header nav missing /docs/ link");
    assert.ok(home.includes("github.com/juanre/possiblymadebyahuman"), "home missing repo link");
    assert.ok(home.includes("MIT licensed"), "home missing OSS/MIT footer line");
    assert.ok(home.includes("href=/docs/privacy/"), "home footer missing Privacy link");
    assert.ok(home.includes("href=/docs/terms/"), "home footer missing Terms link");
    assert.ok(home.includes("Brought to you by"), "home missing aweb.ai credit");
    assert.ok(home.includes("href=https://aweb.ai"), "home missing aweb.ai link");

    // SEO / social card surface on the home page.
    assert.ok(/<link rel=canonical href=https:\/\/possiblymadebyahuman.com\/>/.test(home), "home missing canonical link");
    assert.ok(home.includes("og:type") && home.includes("\"website\""), "home missing og:type=website");
    assert.ok(home.includes("og:image") && home.includes("/og/card.jpg"), "home missing og:image");
    assert.ok(home.includes("twitter:card") && home.includes("\"summary_large_image\""), "home missing twitter:card=summary_large_image");
    assert.ok(home.includes("application/ld+json"), "home missing JSON-LD structured data");
    assert.ok(home.includes("\"WebSite\"") && home.includes("\"Organization\""), "home JSON-LD missing WebSite + Organization");
    assert.ok(home.includes("favicon.svg"), "home missing favicon link");
    assert.ok(home.includes("apple-touch-icon"), "home missing apple-touch-icon link");
    assert.ok(home.includes("site.webmanifest"), "home missing webmanifest link");
    assert.ok(home.includes("theme-color"), "home missing theme-color meta");

    const terms = readFileSync(join(out, "docs/terms/index.html"), "utf8");
    assert.ok(terms.includes("provided as-is"), "terms page missing as-is statement");
    assert.ok(terms.includes("not a detector"), "terms page missing not-a-detector framing");
    assert.ok(terms.includes("no public deletion API"), "terms page missing no-deletion caveat");
    assert.ok(!/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(terms), "terms must not publish a Chrome Web Store URL");

    const privacy = readFileSync(join(out, "docs/privacy/index.html"), "utf8");
    assert.ok(privacy.includes("chrome.storage.local"), "privacy missing extension storage disclosure");
    assert.ok(privacy.includes("Server-observed checkpoints"), "privacy missing checkpoint section");
    assert.ok(!home.includes("href=/blog/"), "home must not link to /blog/");
    assert.ok(!home.includes("class=standing-claim"), "per-record standing claim must not appear on the home page");
    assert.ok(!/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(home), "home must not publish a Chrome Web Store URL before approval");

    const emacs = readFileSync(join(out, "docs/emacs/index.html"), "utf8");
    assert.ok(emacs.includes("pmbah-mode"), "emacs page missing pmbah-mode reference");
    assert.ok(emacs.includes("GNU Emacs 29.1"), "emacs page missing GNU Emacs 29.1 requirement");
    assert.ok(emacs.includes("refuses to start in a non-empty buffer"), "emacs page missing the empty-buffer rule");
    assert.ok(!/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(emacs), "emacs page must not publish a Chrome Web Store URL before approval");

    const plaintextFixtures = [" there", "Hi ther!"];
    for (const path of ["index.html", "docs/index.html"]) {
      const body = readFileSync(join(out, path), "utf8");
      for (const plaintext of plaintextFixtures) {
        assert.ok(!body.includes(plaintext), `${path} leaked fixture plaintext: ${plaintext}`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
