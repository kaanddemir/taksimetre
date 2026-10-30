import { expect, test } from "@playwright/test";
import { drive, geo, installFakeGeo } from "./fake-geo.ts";
import { assertLayout, fareText, notice } from "./helpers.ts";

const main = (page: import("@playwright/test").Page) => page.locator("main");

test.describe("real browser geolocation API (Chrome emulation)", () => {
  test("granted: BAŞLAT acquires a fix and starts the meter", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 41.0369, longitude: 28.985, accuracy: 10 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
    expect(await fareText(page)).toBe("Toplam ücret 71,94 ₺");
  });

  test("not granted: no journey, concise message", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    await expect(notice(page)).toHaveText(/Konum izni gerekli|Konum alınamadı/);
    await expect(main(page)).toHaveAttribute("data-status", "SERBEST");
  });
});

test.describe("GPS journey (fake geolocation + fake clock)", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeGeo(page);
    await page.clock.install({ time: new Date("2026-10-30T09:00:00Z") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
  });

  test("acquire → drive → wait → finish → resume, with status feedback", async ({ page }) => {
    const g = geo(page);
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    await expect(notice(page)).toHaveText("Konum alınıyor…");
    await expect(page.locator(".warn")).toBeHidden(); // info, not a warning
    await expect(page.getByRole("button", { name: "İPTAL" })).toBeEnabled();
    await page.clock.runFor(5_000);
    await expect(main(page)).toHaveAttribute("data-status", "SERBEST"); // nothing charged while acquiring
    await g.emit(0);
    await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
    expect(await fareText(page)).toBe("Toplam ücret 71,94 ₺");

    const pos = await drive(page, 0, 40, 54); // 600 m
    expect(await fareText(page)).toBe("Toplam ücret 100,74 ₺");
    await expect(page.locator(".legend.on")).toHaveText(["SEYİR"]);
    await drive(page, pos, 70, 0);
    await expect(page.locator(".legend.on")).toHaveText(["BEKLEME"]);
    expect(await fareText(page)).toBe("Toplam ücret 110,72 ₺");

    await page.getByRole("button", { name: "BİTİR" }).click();
    await page.getByRole("button", { name: /Bitirmek için/ }).click();
    await expect(main(page)).toHaveAttribute("data-status", "UCRET");
    expect(await g.watchCount()).toBe(0);
    await expect(page.locator("#fare-text")).toContainText("Asgari ücret 230,00 ₺ uygulandı");

    await page.clock.runFor(60_000);
    await page.getByRole("button", { name: "DEVAM" }).click();
    await expect(main(page)).toHaveAttribute("data-status", "UCRET"); // waits for a fix
    await g.emit(5_000);
    await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
    expect(await fareText(page)).toBe("Toplam ücret 110,72 ₺"); // no opening fare, no paused time
  });

  test("double start creates one watcher; rotation keeps journey and watcher", async ({ page }) => {
    const g = geo(page);
    await page.getByRole("button", { name: "BAŞLAT" }).dblclick();
    await g.emit(0);
    await drive(page, 0, 20, 54);
    const fare = await fareText(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await assertLayout(page);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await fareText(page)).toBe(fare);
    expect(await g.watchesCreated()).toBe(1);
    expect(await g.watchCount()).toBe(1);
  });

  test("backgrounding: no invented distance, gap reported in the summary", async ({ page }) => {
    const g = geo(page);
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    await g.emit(0);
    const pos = await drive(page, 0, 10, 54);
    const fare = await fareText(page);
    await g.setHidden(true);
    expect(await g.watchCount()).toBe(0);
    await expect(notice(page)).toHaveText("GPS kesildi");
    await page.clock.runFor(120_000);
    await g.emit(pos + 1_500); // arrives while hidden: ignored
    await g.setHidden(false);
    expect(await g.watchCount()).toBe(1);
    expect(await g.watchesCreated()).toBe(2);
    expect(await fareText(page)).toBe(fare);
    await g.emit(pos + 2_000);
    // GPS is back: the warning disappears; the gap is recorded internally only.
    await expect(notice(page)).toHaveCount(0);
    expect(await fareText(page)).toBe(fare);
    await page.getByRole("button", { name: "BİTİR" }).click();
    await page.getByRole("button", { name: /Bitirmek için/ }).click();
    await expect(notice(page)).toHaveCount(0); // no persistent interruption notice
    await expect(page.locator("body")).not.toContainText(/kesildi|ücrete eklenmedi|Eksik/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const st = await page.evaluate(() => JSON.parse(sessionStorage.getItem("taksimetre.journey") ?? "null"));
    expect(JSON.stringify(st)).toMatch(/gapCount":1/); // still tracked internally
    for (const [w, h] of [[320, 568], [667, 375]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await assertLayout(page);
      await page.screenshot({ path: `e2e/.shots/gps-summary-${w}x${h}.png` });
    }
  });

  test("language toggle keeps the GPS watcher and the fare", async ({ page }) => {
    const g = geo(page);
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    await g.emit(0);
    const pos = await drive(page, 0, 20, 54);
    const fare = await fareText(page);
    expect(await g.watchCount()).toBe(1);
    await page.getByRole("button", { name: "Switch to English" }).click();
    await page.getByRole("button", { name: "Türkçeye geç" }).click();
    expect(await g.watchCount()).toBe(1);
    expect(await fareText(page)).toBe(fare);
    await drive(page, pos, 20, 54); // fixes still reach the meter
    expect(await fareText(page)).not.toBe(fare);
  });

  test("signal loss shows weak, then interrupted", async ({ page }) => {
    const g = geo(page);
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    await g.emit(0);
    await page.clock.runFor(7_000);
    await expect(notice(page)).toHaveText("GPS zayıf");
    await page.clock.runFor(10_000);
    await expect(notice(page)).toHaveText("GPS kesildi");
  });

  test("reload during a journey restores the confirmed fare and records the interruption", async ({ page }) => {
    const g = geo(page);
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    await g.emit(0);
    await drive(page, 0, 40, 54);
    const fare = await fareText(page);
    await page.reload();
    await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
    expect(await fareText(page)).toBe(fare);
    await expect(notice(page)).toHaveText("GPS kesildi"); // permission granted → auto reconnect
    await g.emit(1_000);
    await expect(notice(page)).toHaveCount(0); // resolved → hidden; the downtime is recorded, not shown
    expect(await fareText(page)).toBe(fare);
  });

  test("corrupted saved journey is discarded safely", async ({ page }) => {
    await page.evaluate(() => sessionStorage.setItem("taksimetre.journey", "{broken"));
    await page.reload();
    await expect(main(page)).toHaveAttribute("data-status", "SERBEST");
    expect(await page.evaluate(() => sessionStorage.getItem("taksimetre.journey"))).toBeNull();
  });

  test("acquiring state fits both orientations", async ({ page }) => {
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    for (const [w, h] of [[320, 568], [390, 844], [667, 375], [932, 430]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await assertLayout(page);
    }
    await page.screenshot({ path: "e2e/.shots/gps-acquiring-932x430.png" });
  });
});

test.describe("permission denied after reload (fake)", () => {
  test("restored journey without permission waits for the GPS key", async ({ page }) => {
    await installFakeGeo(page, "grant");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    await geo(page).emit(0);
    await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
    await page.evaluate(() => (window as any).__geo.setHidden(true)); // forces a save
    await page.evaluate(() => sessionStorage.setItem("probe", "1"));
    // Next load: permission no longer granted.
    await page.addInitScript(() => ((window as any).__geo.mode = "deny"));
    await page.reload();
    await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
    await expect(notice(page)).toHaveText("GPS kesildi");
    await page.locator(".warn").click(); // non-interactive: nothing opens
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".warn")).not.toHaveAttribute("tabindex");
    await expect(page.getByRole("button", { name: "Konum takibini yeniden başlat" })).toBeEnabled();
  });
});


test("backgrounding during acquisition cancels the watcher and needs a fresh user start", async ({ page }) => {
  await installFakeGeo(page); await page.goto("/");
  const g = geo(page);
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  expect(await g.watchCount()).toBe(1);
  await g.setHidden(true);
  expect(await g.watchCount()).toBe(0);
  await g.setHidden(false); await g.emit(0);
  await expect(main(page)).toHaveAttribute("data-status", "SERBEST");
  expect(await g.watchCount()).toBe(0);
  await page.getByRole("button", { name: "BAŞLAT" }).click(); await g.emit(0);
  await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
  expect(await g.watchCount()).toBe(1);
});

test("inconsistent saved counters are discarded on reload", async ({ page }) => {
  await installFakeGeo(page); await page.goto("/");
  await page.getByRole("button", { name: "BAŞLAT" }).click(); await geo(page).emit(0);
  await expect(main(page)).toHaveAttribute("data-status", "MESGUL");
  const corrupted = await page.evaluate(() => {
    const record = JSON.parse(sessionStorage.getItem("taksimetre.journey")!);
    record.acc.distanceSteps = Number.MAX_SAFE_INTEGER;
    return JSON.stringify(record);
  });
  // Inject after the old page's pagehide saver, before the new app restores.
  await page.addInitScript((record) => sessionStorage.setItem("taksimetre.journey", record), corrupted);
  await page.reload();
  await expect(main(page)).toHaveAttribute("data-status", "SERBEST");
  expect(await page.evaluate(() => sessionStorage.getItem("taksimetre.journey"))).toBeNull();
});
