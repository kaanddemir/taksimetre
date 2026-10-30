import { expect, test } from "@playwright/test";

test("production build: GPS start enabled, no simulator", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 41.0369, longitude: 28.985, accuracy: 10 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?sim");
  await expect(page.locator(".sim-toggle")).toHaveCount(0);
  expect(await page.evaluate(() => "__sim" in window)).toBe(false);
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await expect(page.locator("main")).toHaveAttribute("data-status", "MESGUL");
});

test("production: no third-party network requests during a GPS journey", async ({ page, context }) => {
  const foreign: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("http://localhost:4173")) foreign.push(r.url()); });
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 41.0369, longitude: 28.985, accuracy: 10 });
  await page.goto("/");
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await expect(page.locator("main")).toHaveAttribute("data-status", "MESGUL");
  await page.waitForTimeout(1500);
  expect(foreign).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem("taksimetre.journey") ?? "")).not.toMatch(/41\.03|28\.98|latitude/);
});

test("production ?diag shows aggregate stats only (no coordinates)", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 41.0369, longitude: 28.985, accuracy: 10 });
  await page.goto("/?diag");
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await page.locator(".diag summary").click();
  await expect(page.locator(".diag pre")).toContainText("accuracyMedianM");
  await expect(page.locator(".diag pre")).not.toContainText("41.03");
});
