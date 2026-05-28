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
      "emacs/index.html",
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
    ]) {
      assert.ok(existsSync(join(out, asset)), `${asset} missing from build output`);
    }

    const home = readFileSync(join(out, "index.html"), "utf8");
    assert.ok(home.includes("We cannot prove a human wrote it"), "home missing the headline");
    assert.ok(home.includes("But we can record how you wrote it"), "home missing the H2 counter-claim");
    assert.ok(home.includes("home-figure"), "home missing the hand-drawn figure block");
    assert.ok(home.includes("/images/pmbah-figure"), "home missing the figure asset reference");
    assert.ok(home.includes("href=/write"), "home missing /write CTA");
    assert.ok(home.includes("href=/emacs/"), "home missing /emacs/ CTA");
    assert.ok(home.includes("href=/docs/"), "header nav missing /docs/ link");
    assert.ok(home.includes("github.com/juanre/possiblymadebyahuman"), "home missing repo link");
    assert.ok(home.includes("MIT licensed"), "home missing OSS/MIT footer line");
    assert.ok(home.includes("Brought to you by"), "home missing aweb.ai credit");
    assert.ok(home.includes("href=https://aweb.ai"), "home missing aweb.ai link");
    assert.ok(!home.includes("href=/blog/"), "home must not link to /blog/");
    assert.ok(!home.includes("class=standing-claim"), "per-record standing claim must not appear on the home page");
    assert.ok(!/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(home), "home must not publish a Chrome Web Store URL before approval");

    const emacs = readFileSync(join(out, "emacs/index.html"), "utf8");
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
