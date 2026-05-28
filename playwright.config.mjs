import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PMBAH_FIXTURE_PORT ?? 4173);
const slug = process.env.PMBAH_FIXTURE_SLUG ?? "smoke";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/browser",
  testMatch: /.*\.spec\.mjs$/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    extraHTTPHeaders: { "x-pmbah-fixture-slug": slug },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node tests/browser/serve-fixture.mjs",
    url: `${baseURL}/api/records/${slug}`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    env: {
      PMBAH_FIXTURE_PORT: String(port),
      PMBAH_FIXTURE_SLUG: slug,
    },
  },
});
