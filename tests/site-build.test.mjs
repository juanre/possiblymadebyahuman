import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hugoAvailable = spawnSync("hugo", ["version"], { stdio: "ignore" }).status === 0;

test("hugo builds landing, docs, and blog with content-blind copy and no plaintext fixture leak", { skip: !hugoAvailable ? "hugo binary not available" : undefined }, () => {
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
      "blog/index.html",
    ];

    for (const relative of expected) {
      const path = join(out, relative);
      const body = readFileSync(path, "utf8");
      assert.ok(body.length > 0, `${relative} is empty`);
      assert.ok(body.includes("possiblymadebyahuman"), `${relative} missing product name`);
      assert.ok(body.includes("content-blind"), `${relative} missing content-blind framing`);
    }

    const home = readFileSync(join(out, "index.html"), "utf8");
    assert.ok(home.includes("We cannot prove a human wrote it"), "home missing the standing line");
    assert.ok(home.includes("standing-claim"), "home missing the standing-claim block");
    assert.ok(home.includes("href=/docs/"), "home missing /docs/ link");
    assert.ok(home.includes("href=/blog/"), "home missing /blog/ link");

    const plaintextFixtures = [" there", "Hi ther!"];
    for (const path of ["index.html", "docs/index.html", "blog/index.html"]) {
      const body = readFileSync(join(out, path), "utf8");
      for (const plaintext of plaintextFixtures) {
        assert.ok(!body.includes(plaintext), `${path} leaked fixture plaintext: ${plaintext}`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
