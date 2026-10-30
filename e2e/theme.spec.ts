import { expect, test, type Page } from "@playwright/test";
import { assertLayout, feed, open, sim } from "./helpers.ts";

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const themeBtn = (page: Page) => page.locator("button.theme");
const label = (cur: string, next: string) => `Tema: ${cur}. Dokununca: ${next}`;

test("dark is the fallback when no system preference can be read", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "matchMedia", { value: undefined }));
  await open(page, 390, 844);
  expect(await theme(page)).toBe("dark");
  expect(await bg(page)).toBe("rgb(18, 17, 20)"); // existing dark face unchanged
});

test("System is the default and follows the device live", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, 390, 844);
  await expect(themeBtn(page)).toHaveAttribute("aria-label", label("Sistem", "Açık"));
  expect(await theme(page)).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => theme(page)).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => theme(page)).toBe("light");
});

test("one tap cycles System → Light → Dark → System; icon and label follow; saved across reloads", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, 390, 844);
  const btn = themeBtn(page);
  const icon = () => btn.innerHTML();
  const icons = new Set([await icon()]);
  await btn.click();
  await expect(btn).toHaveAttribute("aria-label", label("Açık", "Koyu"));
  expect(await theme(page)).toBe("light");
  icons.add(await icon());
  await btn.click();
  await expect(btn).toHaveAttribute("aria-label", label("Koyu", "Sistem"));
  expect(await theme(page)).toBe("dark"); // device says light, choice says dark
  icons.add(await icon());
  expect(icons.size).toBe(3); // one distinct icon per preference
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  expect(await theme(page)).toBe("dark"); // manual choice ignores device changes
  await page.reload();
  expect(await theme(page)).toBe("dark");
  await expect(btn).toHaveAttribute("aria-label", label("Koyu", "Sistem"));
  await btn.click();
  await expect(btn).toHaveAttribute("aria-label", label("Sistem", "Açık"));
  expect(await theme(page)).toBe("light"); // back to following the device
  await page.reload();
  await expect(btn).toHaveAttribute("aria-label", label("Sistem", "Açık"));
});

test("no popup, no visible text; keyboard works; label follows language", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, 390, 844);
  const btn = themeBtn(page);
  await expect(btn).not.toHaveAttribute("aria-haspopup");
  expect((await btn.innerText()).trim()).toBe("");
  await btn.click();
  await expect(page.locator("[role=menu], [role=dialog], [role=listbox]")).toHaveCount(0);
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(btn).toBeFocused();
  await expect(btn).toHaveAttribute("aria-label", label("Koyu", "Sistem"));
  await page.keyboard.press("Space");
  await expect(btn).toHaveAttribute("aria-label", label("Sistem", "Açık"));
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(btn).toHaveAttribute("aria-label", "Theme: System. Tap for Light");
});

test("toggle: unboxed, 44 px, aligned with TR/EN", async ({ page }) => {
  await open(page, 390, 844);
  const [b, l] = [(await themeBtn(page).boundingBox())!, (await page.getByRole("button", { name: "Switch to English" }).boundingBox())!];
  expect(b.width).toBeGreaterThanOrEqual(44);
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(Math.abs(b.y + b.height / 2 - (l.y + l.height / 2))).toBeLessThan(0.5);
  expect(l.x - (b.x + b.width)).toBeLessThan(1);
  const style = await themeBtn(page).evaluate((e) => [getComputedStyle(e).borderStyle, getComputedStyle(e).backgroundColor]);
  expect(style).toEqual(["none", "rgba(0, 0, 0, 0)"]);
});

test("changing theme mid-journey never resets or pauses the journey", async ({ page }) => {
  await open(page, 390, 844);
  await sim(page, "pause", true);
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await feed(page, 600_000, 60_000, 36);
  const before = await page.evaluate(() => JSON.stringify((window as any).__sim.store.get()));
  const led = await page.locator(".led-fare").innerHTML();
  for (let i = 0; i < 4; i++) await themeBtn(page).click(); // System → Light → Dark → System → Light
  expect(await theme(page)).toBe("light");
  expect(await page.evaluate(() => JSON.stringify((window as any).__sim.store.get()))).toBe(before);
  expect(await page.locator(".led-fare").innerHTML()).toBe(led);
  await expect(page.locator("main")).toHaveAttribute("data-status", "MESGUL");
  await feed(page, 100_000, 10_000, 36);
  expect(await page.locator(".led-fare").innerHTML()).not.toBe(led);
});

test("saved light theme applies on the GPS (non-simulator) page and sets the browser theme colour", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(await theme(page)).toBe("light");
  expect(await page.evaluate(() => document.querySelector('meta[name="theme-color"]')!.getAttribute("content"))).toBe("#e9e7e3");
});

for (const t of ["dark", "light"] as const) {
  test(`${t} theme fits mobile sizes in every state`, async ({ page }) => {
    await page.addInitScript((v) => localStorage.setItem("theme", v), t);
    await open(page, 390, 844);
    await sim(page, "pause", true);
    expect(await theme(page)).toBe(t);
    const sizes = [[320, 568], [390, 844], [667, 375], [844, 390]] as const;
    const shoot = async (state: string) => {
      for (const [w, h] of sizes) {
        await page.setViewportSize({ width: w, height: h });
        await assertLayout(page);
        const [tb, lb] = [(await page.locator(".theme").boundingBox())!, (await page.locator(".lang:not(.theme)").boundingBox())!];
        expect(Math.abs(tb.y - lb.y)).toBeLessThan(0.5);
        expect(tb.x + tb.width).toBeLessThanOrEqual(lb.x + 0.5);
        const br = (await page.locator(".brand").boundingBox())!;
        expect(Math.abs(br.y + br.height / 2 - (lb.y + lb.height / 2))).toBeLessThan(0.5); // same line as TR/EN
        expect(br.x + br.width).toBeLessThan(tb.x); // far left, never touching the controls
        await page.screenshot({ path: `e2e/.shots/theme-${t}-${state}-${w}x${h}.png` });
      }
    };
    await shoot("idle");
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    await feed(page, 1_000_000, 60_000, 60);
    await shoot("running");
    await page.getByRole("button", { name: "BİTİR" }).click();
    await page.getByRole("button", { name: /Bitirmek için/ }).click();
    await shoot("fare");
  });
}
