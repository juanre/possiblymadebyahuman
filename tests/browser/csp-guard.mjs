import { expect, test as base } from "@playwright/test";

export { expect };

/** Collects Content Security Policy violations reported by every page of a context. */
export function watchCspViolations(context) {
  const violations = [];
  const watch = page => page.on("console", message => {
    if (/Content Security Policy/i.test(message.text())) violations.push(`${page.url()}: ${message.text()}`);
  });
  context.pages().forEach(watch);
  context.on("page", watch);
  return violations;
}

/** Playwright's test, failing any test whose pages report a CSP violation. */
export const test = base.extend({
  context: async ({ context }, use) => {
    const violations = watchCspViolations(context);
    await use(context);
    expect(violations, "Content Security Policy violations").toEqual([]);
  },
});
