import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const siteRoot = "apps/site";
const contentRoot = join(siteRoot, "content");

const read = (path) => readFile(path, "utf8");

const requiredDocPages = [
  "product-promise.md",
  "claims.md",
  "privacy.md",
  "terms.md",
  "records.md",
  "verification.md",
  "threat-model.md",
  "conformance.md",
  "routing.md",
  "server-observed-commitments.md",
  "emacs.md",
];

const sectionsCoveringProductPromise = [
  { file: "_index.md", needs: ["We cannot prove a human wrote it", "But we can record the writing process", "reverse Turing test", "/write", "/docs/emacs/"] },
  { file: "docs/emacs.md", needs: ["pmbah-mode", "GNU Emacs 29.1", "Open a writing buffer", "length-derived stats may be unknown"] },
  { file: "docs/product-promise.md", needs: ["never uploaded, stored, or reconstructed", "recompute the signature in their own browser", "human-or-machine"] },
  { file: "docs/claims.md", needs: ["We claim", "We do not claim"] },
  { file: "docs/privacy.md", needs: ["content-blind", "capture context", "no public deletion API", "no user system", "chrome.storage.local", "bearer", "Server-observed checkpoints", "GitHub issues"] },
  { file: "docs/terms.md", needs: ["MIT licensed", "provided as-is", "no public deletion API", "not a detector", "Identity and authorship assertions", "Moderation and removal", "project issue tracker"] },
  { file: "docs/records.md", needs: ["buffer mutation", "short_signature", "Hash chain", "Reserved route prefixes"] },
  { file: "docs/verification.md", needs: ["Signature & details", "Computed hash", "hash chain", "What this does and does not mean"] },
  { file: "docs/threat-model.md", needs: ["adversary", "Retype an AI draft", "hash chain detects any change"] },
  { file: "docs/conformance.md", needs: ["Canonicalization vectors", "Capability accuracy", "Content-blindness", "Capture-context preview"] },
  { file: "docs/routing.md", needs: ["/api/", "/docs/", "short_signature", "SITE_DIST_DIR"] },
  {
    file: "docs/server-observed-commitments.md",
    needs: [
      "Server observed checkpoints",
      "Partially observed",
      "Not observed",
      "No observation requested",
      "Server-observed span",
      "wall-clock distance between the first and last commitments; it does not count active typing, and it includes any idle gaps between commitments.",
      "after-the-fact fabrication materially more work",
    ],
  },
];

const banVerdictPatterns = [
  /\b(?:score|verdict)\s*[:=]\s*\d/i,
  /\bcertified\s+as\s+human\b/i,
  /\bbadge\s+of\s+humanity\b/i,
  /\bguaranteed\s+human(?:-?(?:written|authored))?\b/i,
];

test("hugo config is configured for the content-blind landing + docs surface", async () => {
  const hugo = await read(join(siteRoot, "hugo.toml"));
  assert.match(hugo, /possiblymadebyahuman\.com/);
  assert.match(hugo, /title = 'possiblymadebyahuman'/);
  assert.match(hugo, /unsafe = true/);
});

test("home content names the two producers, the not-a-detector framing, and no fake CWS install URL", async () => {
  const home = await read(join(contentRoot, "_index.md"));
  // Headline + counter + closer voice.
  assert.match(home, /We cannot prove a human wrote it/);
  assert.match(home, /But we can record the writing process/);
  assert.match(home, /reverse Turing test/);
  // The two producers the page invites the reader to try.
  assert.match(home, /\/write/, "home must link to /write");
  assert.match(home, /\/docs\/emacs\//, "home must link to /docs/emacs/");
  // Hard rules: no blog, no per-record standing-claim block in body, no
  // detector wording, no placeholder Chrome Web Store install URL on home
  // (gated until .26 records the real listing).
  assert.doesNotMatch(home, /\/blog\//, "home must not link to a blog");
  assert.doesNotMatch(home, /standing-claim/, "per-record standing claim must not appear on the home page");
  assert.doesNotMatch(home, /\bdetector\s+score\b/i);
  assert.doesNotMatch(home, /chromewebstore\.google\.com|chrome\.google\.com\/webstore/i, "home must not publish a Chrome Web Store URL before approval");
});

test("required doc pages exist and cover the SOT-mandated topics", async () => {
  const docsDir = await readdir(join(contentRoot, "docs"));
  for (const page of requiredDocPages) {
    assert.ok(docsDir.includes(page), `missing required doc page: ${page}`);
  }
});

test("each doc page renders content-aligned content and avoids verdict language", async () => {
  for (const { file, needs } of sectionsCoveringProductPromise) {
    const body = await read(join(contentRoot, file));
    for (const needle of needs) {
      assert.ok(body.includes(needle), `${file} missing required content: ${needle}`);
    }
    for (const pattern of banVerdictPatterns) {
      assert.doesNotMatch(body, pattern, `${file} contains banned verdict-style copy: ${pattern}`);
    }
  }
});

test("layout base sets the candid description, provides site nav with producer CTAs, exposes the OSS/MIT footer, and links no blog route", async () => {
  const base = await read(join(siteRoot, "layouts/_default/baseof.html"));
  // The description is now templated through `$siteDescription`; match on the
  // assignment so the test still anchors on the canonical text.
  assert.match(base, /\$siteDescription := "A content-blind writing-record service/);
  // SEO/social tag scaffolding on every page (template form).
  assert.match(base, /rel="canonical"/);
  assert.match(base, /rel="icon" href="\/favicon\.svg"/);
  assert.match(base, /rel="manifest" href="\/site\.webmanifest"/);
  assert.match(base, /property="og:image"/);
  assert.match(base, /name="twitter:card" content="summary_large_image"/);
  assert.match(base, /application\/ld\+json/);
  assert.match(base, /aria-label="Site sections"/);
  // Left rail: Home + Docs.
  assert.match(base, /href="\/docs\/"/);
  // Center CTAs: Write + Emacs.
  assert.match(base, /class="site-nav-cta" href="\/write"/);
  assert.match(base, /class="site-nav-cta" href="\/docs\/emacs\/"/);
  // Right rail: GitHub.
  assert.match(base, /href="https:\/\/github\.com\/juanre\/possiblymadebyahuman"/);
  assert.match(base, /class="site-nav-repo"/);
  // Footer.
  assert.match(base, /href="\/docs\/privacy\/">Privacy</);
  assert.match(base, /href="\/docs\/terms\/">Terms</);
  assert.match(base, /Open source/);
  assert.match(base, /MIT licensed/);
  assert.match(base, /Brought to you by/);
  assert.match(base, /href="https:\/\/aweb\.ai"/);
  assert.doesNotMatch(base, /href="\/blog\/"/);
});

test("SOT M5 milestone is reflected by the implemented site structure", async () => {
  const sot = await read("docs/sot.md");
  for (const phrase of [
    "Implement landing page",
    "Add docs and threat model pages",
    "Ensure routing works with Vite app and backend",
  ]) {
    assert.match(sot, new RegExp(phrase));
  }
});
