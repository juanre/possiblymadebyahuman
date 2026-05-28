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
  "records.md",
  "verification.md",
  "threat-model.md",
  "conformance.md",
  "routing.md",
];

const sectionsCoveringProductPromise = [
  { file: "_index.md", needs: ["content-blind", "We cannot prove a human wrote it"] },
  { file: "docs/product-promise.md", needs: ["No verdicts", "Process, not content", "Hash-addressed records"] },
  { file: "docs/claims.md", needs: ["We claim", "We do not claim"] },
  { file: "docs/privacy.md", needs: ["content-blind", "capture context", "no public deletion API", "no user system"] },
  { file: "docs/records.md", needs: ["buffer mutation", "short_signature", "Hash chain", "Reserved route prefixes"] },
  { file: "docs/verification.md", needs: ["Re-verify chain", "hash chain", "What verification does and does not mean"] },
  { file: "docs/threat-model.md", needs: ["adversary", "Retype an AI draft", "hash chain detects any change"] },
  { file: "docs/conformance.md", needs: ["Canonicalization vectors", "Capability honesty", "Content-blindness", "Capture-context preview"] },
  { file: "docs/routing.md", needs: ["/api/", "/docs/", "/blog/", "short_signature", "SITE_DIST_DIR"] },
];

const banVerdictPatterns = [
  /\b(?:score|verdict)\s*[:=]\s*\d/i,
  /\bcertified\s+as\s+human\b/i,
  /\bbadge\s+of\s+humanity\b/i,
  /\bguaranteed\s+human(?:-?(?:written|authored))?\b/i,
];

test("hugo config enables content-blind landing + docs + blog sections", async () => {
  const hugo = await read(join(siteRoot, "hugo.toml"));
  assert.match(hugo, /possiblymadebyahuman\.com/);
  assert.match(hugo, /title = 'possiblymadebyahuman'/);
  assert.match(hugo, /unsafe = true/);
});

test("home content reinforces product promise and links to docs and blog", async () => {
  const home = await read(join(contentRoot, "_index.md"));
  assert.match(home, /content-blind writing-record/);
  assert.match(home, /standing-claim/);
  assert.match(home, /\/docs\//);
  assert.match(home, /\/blog\//);
  assert.doesNotMatch(home, /\bdetector\s+score\b/i);
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

test("blog scaffold has an index and at least one dated post", async () => {
  const blogDir = await readdir(join(contentRoot, "blog"));
  assert.ok(blogDir.includes("_index.md"), "blog/_index.md missing");
  const posts = blogDir.filter((entry) => entry !== "_index.md" && entry.endsWith(".md"));
  assert.ok(posts.length >= 1, "blog must contain at least one post");
  for (const post of posts) {
    const body = await read(join(contentRoot, "blog", post));
    assert.match(body, /^---/, `${post} missing front matter`);
    assert.match(body, /\ndate:\s*20\d\d-\d\d-\d\d/, `${post} missing ISO date`);
    assert.match(body, /\nsummary:\s*"/, `${post} missing summary`);
  }
});

test("layout base sets the candid description and provides site nav", async () => {
  const base = await read(join(siteRoot, "layouts/_default/baseof.html"));
  assert.match(base, /content="A content-blind writing-record service/);
  assert.match(base, /aria-label="Site sections"/);
  assert.match(base, /href="\/docs\/"/);
  assert.match(base, /href="\/blog\/"/);
  const blogList = await read(join(siteRoot, "layouts/blog/list.html"));
  assert.match(blogList, /ByDate\.Reverse/);
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
