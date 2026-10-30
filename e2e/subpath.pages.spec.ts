import { expect, test } from "@playwright/test";
import { PAGES_SUBPATH } from "../playwright.config.ts";

/**
 * The unchanged production build served under a repository sub-path, like a GitHub Pages project
 * site. Everything (manifest, icons, chunks, service worker scope, offline shell) must stay inside it.
 */
const ORIGIN = "http://localhost:4174";
const BASE = ORIGIN + PAGES_SUBPATH;

test("app, manifest and icons resolve inside the sub-path; nothing is requested outside it", async ({ page, request }) => {
  const outside: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(BASE)) outside.push(r.url());
  });
  await page.goto("./");
  await expect(page.getByRole("button", { name: "BAŞLAT" })).toBeVisible();
  const manifestUrl = await page.locator('link[rel="manifest"]').evaluate((l) => (l as HTMLLinkElement).href);
  expect(manifestUrl).toBe(`${BASE}manifest.webmanifest`);
  const m = await (await request.get(manifestUrl)).json();
  // Relative manifest URLs resolve against the manifest itself, so they land in the sub-path.
  expect(new URL(m.start_url, manifestUrl).href).toBe(BASE);
  expect(new URL(m.scope, manifestUrl).href).toBe(BASE);
  for (const icon of m.icons) expect((await request.get(new URL(icon.src, manifestUrl).href)).ok(), icon.src).toBe(true);
  await page.waitForLoadState("networkidle");
  expect(outside).toEqual([]);
  expect((await request.get(`${ORIGIN}/manifest.webmanifest`)).ok()).toBe(false); // really served from the sub-path only
});

test("service worker is scoped to the sub-path and the app launches offline there", async ({ page, context }) => {
  await page.goto("./");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(BASE);
  await page.evaluate(async () => {
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  });
  const cached = await page.evaluate(async () => {
    const [key] = await caches.keys();
    return (await (await caches.open(key!)).keys()).map((r) => r.url);
  });
  expect(cached).toContain(BASE);
  expect(cached.every((u) => u.startsWith(BASE))).toBe(true);
  await context.setOffline(true);
  await page.goto("./?diag");
  await expect(page.getByRole("button", { name: "BAŞLAT" })).toBeVisible();
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("data-status", "SERBEST");
  await context.setOffline(false);
});
