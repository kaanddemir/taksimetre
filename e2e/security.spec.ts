import { expect, test } from "@playwright/test";

test("development CSP supports nonce-authorized CSS and only the local HMR socket", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as any).__violations.push(e.effectiveDirective));
  });
  await page.goto("/?sim");
  await page.waitForFunction(() => "__sim" in window);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  expect(policy).toContain("ws://localhost:5173");
  expect(policy).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/]+'/);
  expect(await page.locator("style[data-vite-dev-id]").count()).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__violations)).toEqual([]);
});
