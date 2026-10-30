import { expect, test } from "@playwright/test";
import { assertLayout, fareText, feed, open, sim } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await open(page, 390, 844);
  await sim(page, "pause", true);
});

test("start shows the engine opening fare; SERBEST → SEYİR → BEKLEME", async ({ page }) => {
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  expect(await fareText(page)).toBe("Toplam ücret 71,94 ₺");
  await feed(page, 1_000_000, 60_000, 60);
  expect(await fareText(page)).toBe("Toplam ücret 119,94 ₺");
  await expect(page.locator(".legend.on")).toHaveText(["SEYİR"]);
  await feed(page, 0, 120_000, 0);
  expect(await fareText(page)).toBe("Toplam ücret 139,90 ₺");
  await expect(page.locator(".legend.on")).toHaveText(["BEKLEME"]);
});

test("double-tapping start does not double-charge or finish", async ({ page }) => {
  await page.getByRole("button", { name: "BAŞLAT" }).dblclick();
  expect(await fareText(page)).toBe("Toplam ücret 71,94 ₺");
  await expect(page.locator(".legend.on")).toHaveCount(0);
  await expect(page.locator("main")).toHaveAttribute("data-status", "MESGUL");
});

test("finish needs confirmation; minimum applied and explained; fare frozen", async ({ page }) => {
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await feed(page, 1_000_000, 60_000, 60);
  await page.getByRole("button", { name: "BİTİR" }).click();
  await expect(page.locator("main")).toHaveAttribute("data-status", "MESGUL");
  await page.getByRole("button", { name: /Bitirmek için/ }).click();
  await expect(page.locator("main")).toHaveAttribute("data-status", "UCRET");
  expect(await fareText(page)).toMatch(/^Ödenecek tahmini tutar 230,00 ₺\. Asgari ücret 230,00 ₺ uygulandı/);
  await expect(page.locator(".notice")).not.toContainText("Asgari");
  await expect(page.locator(".legend.on")).toHaveText(["ÜCRET"]);
  await sim(page, "pause", false);
  await page.waitForTimeout(600);
  expect(await fareText(page)).toMatch(/^Ödenecek tahmini tutar 230,00 ₺\./); // frozen
});

test("resume continues without a second opening fare; clear after display time", async ({ page }) => {
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await feed(page, 10_000_000, 600_000, 60);
  await page.getByRole("button", { name: "BİTİR" }).click();
  await page.getByRole("button", { name: /Bitirmek için/ }).click();
  await expect(page.getByRole("button", { name: "SERBEST" })).toBeDisabled();
  await page.getByRole("button", { name: "DEVAM" }).click();
  expect(await fareText(page)).toBe("Toplam ücret 551,94 ₺");
  await page.getByRole("button", { name: "BİTİR" }).click();
  await page.getByRole("button", { name: /Bitirmek için/ }).click();
  await sim(page, "setRate", 60); // 10 virtual seconds pass quickly
  await expect(page.getByRole("button", { name: "SERBEST" })).toBeEnabled({ timeout: 3_000 });
  await page.getByRole("button", { name: "SERBEST" }).click();
  await expect(page.locator("main")).toHaveAttribute("data-status", "SERBEST");
  expect(await fareText(page)).toBe("Taksimetre serbest");
});

test("tariff selection: cycles when idle, locked during a journey", async ({ page }) => {
  const tariffBtn = page.locator(".controls .key").first();
  await tariffBtn.click();
  await expect(page.locator(".cat")).toHaveText("Turkuaz · D segment");
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  expect(await fareText(page)).toBe("Toplam ücret 82,73 ₺");
  await expect(tariffBtn).toBeDisabled();
});

test("orientation change keeps the same journey", async ({ page }) => {
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await feed(page, 2_345_000, 200_000, 50);
  const before = await fareText(page);
  const started = await page.evaluate(() => (window as any).__sim.store.get().meter.journey.startedAtMs);
  await page.setViewportSize({ width: 844, height: 390 });
  expect(await fareText(page)).toBe(before);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await fareText(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).__sim.store.get().meter.journey.startedAtMs)).toBe(started);
});

test("keyboard operable with visible focus; accessible names; LED hidden from AT", async ({ page }) => {
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toHaveText("BAŞLAT");
  const outline = await focused.evaluate((e) => getComputedStyle(e).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toHaveAttribute("data-status", "MESGUL");
  await expect(page.getByRole("status")).toHaveText("Yolculuk başladı");
  for (const svg of await page.locator("svg.led").all()) await expect(svg).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".legends")).toHaveAttribute("aria-hidden", "true");
});

test("language toggle: one tap switches, keyboard works, preference survives reload", async ({ page }) => {
  const tr = page.getByRole("button", { name: "Switch to English" });
  await expect(tr).toHaveText("TR");
  await expect(page.locator("[role=menu]")).toHaveCount(0); // no dropdown any more
  const box = (await tr.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await tr.evaluate((e) => getComputedStyle(e).borderStyle)).toBe("none");

  await tr.click();
  const en = page.getByRole("button", { name: "Türkçeye geç" });
  await expect(en).toHaveText("EN");
  await expect(page.getByRole("button", { name: "START" })).toBeVisible();
  await expect(page.locator(".legend").first()).toHaveText("SERBEST"); // device legends stay Turkish
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.reload();
  await expect(page.getByRole("button", { name: "Türkçeye geç" })).toHaveText("EN");
  await page.getByRole("button", { name: "Türkçeye geç" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Switch to English" })).toBeFocused();
  await expect(page.getByRole("button", { name: "BAŞLAT" })).toBeVisible();
});

test("switching language mid-journey does not touch the journey", async ({ page }) => {
  await sim(page, "pause", true);
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await feed(page, 600_000, 60_000, 36);
  const status = await page.locator("main").getAttribute("data-status");
  const led = await page.locator(".led-fare").innerHTML();
  const trip = await page.locator(".trip").innerHTML();
  await page.getByRole("button", { name: "Switch to English" }).click();
  await page.getByRole("button", { name: "Türkçeye geç" }).click();
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.locator("main")).toHaveAttribute("data-status", status!);
  expect(await page.locator(".led-fare").innerHTML()).toBe(led);
  expect(await page.locator(".trip").innerHTML()).toBe(trip);
  await expect(page.getByRole("button", { name: "FINISH" })).toBeEnabled();
  await feed(page, 100_000, 10_000, 36); // meter keeps running after the switch
  expect(await page.locator(".led-fare").innerHTML()).not.toBe(led);
});


test("simulator drives the real engine", async ({ page }) => {
  await sim(page, "setScenario", "stationary");
  await sim(page, "setRate", 60);
  await sim(page, "pause", false);
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await expect(page.locator(".legend.on")).toHaveText(["BEKLEME"], { timeout: 3_000 });
  await expect.poll(async () => (await fareText(page)) !== "Toplam ücret 71,94 ₺", { timeout: 5_000 }).toBe(true);
});

test("blocked storage (privacy settings): the app still starts with defaults", async ({ page }) => {
  await page.addInitScript(() => {
    for (const k of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(window, k, { get: () => { throw new DOMException("blocked", "SecurityError"); } });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "BAŞLAT" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to English" }).click();
  await page.locator("button.theme").click();
  await expect(page.getByRole("button", { name: "START" })).toBeVisible();
});

test("storage methods that throw cannot prevent startup or preference changes", async ({ page }) => {
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"]) {
      Object.defineProperty(Storage.prototype, method, { value: () => { throw new DOMException("blocked", "SecurityError"); } });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "BAŞLAT" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to English" }).click();
  await page.locator("button.theme").click();
  await expect(page.getByRole("button", { name: "START" })).toBeVisible();
});
