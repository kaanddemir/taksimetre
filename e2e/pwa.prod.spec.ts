import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const SW_FILE = new URL("../dist/sw.js", import.meta.url);

/** Production build (vite preview): manifest, offline shell and the safe update lifecycle. */
test.describe.configure({ mode: "serial" }); // the update test rewrites dist/sw.js

const main = (page: Page) => page.locator("main");

/** Waits until the service worker is active and controls the page. */
async function controlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  });
}
const cacheKeys = (page: Page) => page.evaluate(() => caches.keys());
/** Emulates the app going to the background / coming back (Playwright pages are always visible). */
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
/** PNG width/height from the IHDR chunk. */
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

test("manifest and icons are valid and base-relative", async ({ page, request }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("./manifest.webmanifest"); // relative: works under any domain or sub-path
  const res = await request.get(href!);
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({ name: "Taksimetre", short_name: "Taksimetre", lang: "tr", display: "standalone", start_url: "./", scope: "./", id: "./" });
  expect(m.orientation).toBeUndefined(); // portrait and landscape, never locked
  expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  for (const purpose of ["any", "maskable"]) {
    for (const size of [192, 512]) {
      const icon = m.icons.find((i: { purpose: string; sizes: string }) => i.purpose === purpose && i.sizes === `${size}x${size}`);
      expect(icon, `${purpose} ${size}`).toBeTruthy();
      const r = await request.get(icon.src);
      expect(r.headers()["content-type"]).toContain("image/png");
      expect(pngSize(await r.body())).toEqual([size, size]);
    }
  }
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(pngSize(await (await request.get(apple!)).body())).toEqual([180, 180]);
  expect((await request.get((await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute("href"))!)).ok()).toBe(true);
  // Every script and stylesheet URL is relative too.
  for (const sel of ["script[src]", "link[rel=stylesheet]"]) {
    for (const u of await page.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? e.getAttribute("href")))) expect(u).toMatch(/^\.\//);
  }
});

test("service worker precaches the shell; the app launches offline with preferences intact", async ({ page, context }) => {
  await page.goto("/");
  await controlled(page);
  const keys = await cacheKeys(page);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(/^taksimetre:http%3A%2F%2Flocalhost%3A4173%2F:[0-9a-f]{12}$/);
  const cached = await page.evaluate(async (k) => (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname), keys[0]!);
  expect(cached).toEqual(expect.arrayContaining(["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/maskable-512.png"]));
  expect(cached.some((p) => /^\/assets\/index-.*\.js$/.test(p))).toBe(true);
  expect(cached.some((p) => /^\/assets\/diag-.*\.js$/.test(p))).toBe(true); // lazy chunk works offline too
  expect(cached.some((p) => p.endsWith("sw.js"))).toBe(false);

  await page.getByRole("button", { name: "Switch to English" }).click();
  const theme = page.locator("button.theme");
  await theme.click(); // System → Light
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "START" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.goto("/?diag"); // any in-scope navigation gets the shell
  await expect(page.getByRole("button", { name: "START" })).toBeVisible();
  // Nothing user-specific is cached: only the build's own files.
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(1);
  await context.setOffline(false);
});

test("journey survives a reload served by the service worker", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 41.0369, longitude: 28.985, accuracy: 10 });
  await page.goto("/");
  await controlled(page);
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
  const fare = await page.locator("#fare-text").textContent();
  await context.setOffline(true); // network loss does not matter: nothing is fetched
  await page.reload();
  await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
  await expect(page.locator("#fare-text")).toHaveText(fare!);
  await context.setOffline(false);
});

test("update waits through a journey and its fare display, then applies while idle and hidden", async ({ page, context }) => {
  test.setTimeout(60_000);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 41.0369, longitude: 28.985, accuracy: 10 });
  await page.goto("/");
  await controlled(page);
  const [oldCache] = await cacheKeys(page);

  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
  await page.evaluate(() => ((window as any).__samePage = true)); // gone if the page reloads

  // Publish a new version: same files, different build id. (Playwright cannot route the service
  // worker script request, so the served file is changed on disk and restored afterwards.)
  const original = readFileSync(SW_FILE, "utf8");
  writeFileSync(SW_FILE, original.replace(/const VERSION = "([0-9a-f]+)"/, 'const VERSION = "$1ffff"'));
  try {
    await page.evaluate(async () => {
      const reg = (await navigator.serviceWorker.getRegistration())!;
      await reg.update();
      while (!reg.waiting) await new Promise((r) => setTimeout(r, 50));
    });
    expect(await cacheKeys(page)).toHaveLength(2); // new version downloaded, old one still serving

    const stillOld = async () => {
      expect(await page.evaluate(() => (window as any).__samePage)).toBe(true);
      expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())!.waiting)).toBe(true);
    };
    await setHidden(page, true); // screen locked mid-journey
    await page.waitForTimeout(500);
    await stillOld();
    await setHidden(page, false);
    await expect(main(page)).toHaveAttribute("data-status", "MESGUL");

    await page.getByRole("button", { name: "BİTİR" }).click();
    await page.getByRole("button", { name: /Bitirmek için/ }).click();
    await expect(main(page)).toHaveAttribute("data-status", "UCRET");
    await setHidden(page, true); // final fare still on screen: not safe either
    await page.waitForTimeout(500);
    await stillOld();
    await setHidden(page, false);

    const clear = page.getByRole("button", { name: "SERBEST" });
    await expect(clear).toBeEnabled({ timeout: 15_000 });
    await clear.click();
    await expect(main(page)).toHaveAttribute("data-status", "SERBEST");
    await page.waitForTimeout(300);
    await stillOld(); // idle but visible: no reload in front of the user

    const reloaded = page.waitForEvent("load");
    await setHidden(page, true); // idle and in the background: safe point
    await reloaded;
    await controlled(page);
    expect(await page.evaluate(() => (window as any).__samePage)).toBeUndefined();
    const keys = await cacheKeys(page);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(oldCache); // obsolete cache removed
    expect(keys[0]).toMatch(/ffff$/);
    await expect(main(page)).toHaveAttribute("data-status", "SERBEST");
    await page.getByRole("button", { name: "Taksimetre hakkında" }).click();
    await expect(page.getByRole("dialog")).toContainText(/Sürüm [0-9a-f]{8}/);
  } finally {
    writeFileSync(SW_FILE, original);
  }
});


test("an idle tab cannot activate an update over a second tab's journey; closing it releases the update", async ({ page, context }) => {
  test.setTimeout(40_000);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 41.0369, longitude: 28.985, accuracy: 10 });
  await page.goto("/"); await controlled(page);
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
  const activeFare = await page.locator("#fare-text").textContent();
  const idle = await context.newPage();
  await idle.goto("/"); await controlled(idle);
  await page.evaluate(() => (window as any).__samePage = true);
  await idle.evaluate(() => (window as any).__samePage = true);
  const original = readFileSync(SW_FILE, "utf8");
  writeFileSync(SW_FILE, original.replace(/const VERSION = "([0-9a-f]+)"/, 'const VERSION = "$1aaaa"'));
  try {
    await idle.evaluate(async () => {
      const reg = (await navigator.serviceWorker.getRegistration())!;
      await reg.update();
      while (!reg.waiting) await new Promise((r) => setTimeout(r, 50));
    });
    await setHidden(idle, true);
    await idle.waitForTimeout(700);
    expect(await idle.evaluate(() => (window as any).__samePage)).toBe(true);
    expect(await page.evaluate(() => (window as any).__samePage)).toBe(true);
    await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
    expect(await page.locator("#fare-text").textContent()).toBe(activeFare);
    expect(await idle.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())!.waiting)).toBe(true);
    expect(await cacheKeys(idle)).toHaveLength(2); // active window still has its old cache
    const reload = idle.waitForEvent("load", { timeout: 12_000 });
    await page.close(); // no consent snapshot/lease can linger after this client disappears
    await reload; await controlled(idle);
    expect(await idle.evaluate(() => (window as any).__samePage)).toBeUndefined();
    await expect(main(idle)).toHaveAttribute("data-status", "SERBEST");
    expect(await cacheKeys(idle)).toHaveLength(1);
  } finally {
    writeFileSync(SW_FILE, original);
    await idle.close();
  }
});

test("sibling deployments keep independent caches, update independently and both launch offline", async ({ page, context }) => {
  test.setTimeout(30_000);
  const dist = new URL("../dist/", import.meta.url);
  const names = readdirSync(dist);
  const paths = [new URL("isolation-a/", dist), new URL("isolation-b/", dist)];
  for (const path of paths) {
    mkdirSync(path);
    for (const name of names) cpSync(new URL(name, dist), new URL(name, path), { recursive: true });
  }
  const other = await context.newPage();
  try {
    await page.goto("/isolation-a/"); await controlled(page);
    await other.goto("/isolation-b/"); await controlled(other);
    const before = await cacheKeys(page);
    expect(before).toHaveLength(2);
    const bCache = before.find((key) => key.includes("isolation-b%2F"))!;
    expect(bCache).toBeTruthy();
    const script = new URL("sw.js", paths[0]);
    writeFileSync(script, readFileSync(script, "utf8").replace(/const VERSION = "([0-9a-f]+)"/, 'const VERSION = "$1bbbb"'));
    await page.evaluate(async () => {
      const reg = (await navigator.serviceWorker.getRegistration())!;
      await reg.update();
      while (!reg.waiting) await new Promise((r) => setTimeout(r, 50));
    });
    const reload = page.waitForEvent("load");
    await setHidden(page, true); await reload; await controlled(page);
    const after = await cacheKeys(page);
    expect(after).toHaveLength(2);
    expect(after).toContain(bCache);
    expect(after.some((key) => key.endsWith("bbbb"))).toBe(true);
    await context.setOffline(true);
    await other.reload(); await page.reload();
    for (const p of [other, page]) await expect(p.getByRole("button", { name: "BAŞLAT" })).toBeVisible();
  } finally {
    await context.setOffline(false);
    await other.close();
    for (const path of paths) rmSync(path, { recursive: true, force: true });
  }
});
