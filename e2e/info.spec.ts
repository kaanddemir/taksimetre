import { expect, test } from "@playwright/test";
import { drive, geo, installFakeGeo } from "./fake-geo.ts";
import { fareText } from "./helpers.ts";

const open = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Taksimetre hakkında" });

test("footer label opens a visible info panel: estimate, not certified, GPS limits, privacy, tariff", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const btn = open(page);
  await expect(btn).toHaveText(/Taksimetre/i);
  const box = (await btn.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("dialog")).toHaveCount(0); // never shown unasked
  await btn.click();
  const dialog = page.getByRole("dialog", { name: "Taksimetre" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("tahmini ücret hesaplar");
  await expect(dialog).toContainText("Yasal taksimetre değildir");
  await expect(dialog).toContainText("arka planda konum takibi yapmaz");
  await expect(dialog).toContainText("hiçbir yere gönderilmez");
  await expect(dialog).toContainText("Tarife: İBB Meclis Kararı 813 · 20.07.2026");
  // Wide panel, full-width close key with centred label.
  const vw = 390;
  const d = (await dialog.boundingBox())!;
  expect(d.width).toBeGreaterThanOrEqual(vw - 2 * 16 - 1);
  const key = page.getByRole("button", { name: "KAPAT" });
  const k = (await key.boundingBox())!;
  const pad = await dialog.evaluate((n) => parseFloat(getComputedStyle(n).paddingLeft) + parseFloat(getComputedStyle(n).paddingRight) + 2);
  expect(Math.abs(k.width - (d.width - pad))).toBeLessThanOrEqual(1);
  expect(await key.evaluate((n) => getComputedStyle(n).textAlign)).toBe("center");
  await expect(dialog).not.toContainText("Sürüm"); // dev build: no service worker
  await expect(page.getByRole("button", { name: "KAPAT" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(btn).toBeFocused();

  await page.getByRole("button", { name: "Switch to English" }).click();
  await page.getByRole("button", { name: "About Taksimetre" }).click();
  await expect(page.getByRole("dialog")).toContainText("Not a certified taximeter");
  await expect(page.getByRole("dialog")).toContainText("Tariff: IBB Council Decision 813 · 20 July 2026");
  await page.getByRole("button", { name: "CLOSE" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A click on the dimmed backdrop closes it too; a click inside does not.
  await page.getByRole("button", { name: "About Taksimetre" }).click();
  await page.getByRole("dialog").getByText("Location data").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "About Taksimetre" })).toBeFocused();
});

test("info panel fits and is readable in both themes and orientations", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
    for (const [w, h] of [[320, 568], [390, 844], [667, 375], [844, 390], [1440, 900]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      await open(page).click();
      const d = page.getByRole("dialog");
      const b = (await d.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(w);
      expect(b.y + b.height).toBeLessThanOrEqual(h);
      // Short landscape screens scroll inside the panel; the close key stays reachable.
      await page.getByRole("button", { name: "KAPAT" }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "KAPAT" })).toBeInViewport();
      await page.screenshot({ path: `e2e/.shots/info-${theme}-${w}x${h}.png` });
    }
  }
});

test("opening the info panel mid-journey changes nothing", async ({ page }) => {
  await installFakeGeo(page);
  await page.clock.install({ time: new Date("2026-10-30T09:00:00Z") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const g = geo(page);
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await g.emit(0);
  const pos = await drive(page, 0, 20, 54);
  const before = await fareText(page);
  await open(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await drive(page, pos, 20, 54); // fixes keep reaching the meter behind the panel
  await page.keyboard.press("Escape");
  await expect(page.locator("main")).toHaveAttribute("data-status", "MESGUL");
  expect(await fareText(page)).not.toBe(before);
  expect(await g.watchCount()).toBe(1);
  expect(await g.watchesCreated()).toBe(1);
});
