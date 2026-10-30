import { expect, test } from "@playwright/test";
import { assertLayout, fareText, feed, open, sim, SIZES } from "./helpers.ts";

for (const [w, h] of SIZES) {
  test(`layout ${w}×${h}: idle, running, long fare, finalized`, async ({ page }) => {
    await open(page, w, h);
    await assertLayout(page);
    await page.screenshot({ path: `e2e/.shots/idle-${w}x${h}.png` });

    await sim(page, "pause", true);
    await page.getByRole("button", { name: "BAŞLAT" }).click();
    await feed(page, 3_000_000, 180_000, 60);
    await feed(page, 0, 150_000, 0);
    await assertLayout(page);
    await page.screenshot({ path: `e2e/.shots/run-${w}x${h}.png` });

    // 3 × 100 km: fare exceeds 9,999.99 TL, the LED must grow, not clip.
    for (let i = 0; i < 3; i++) await feed(page, 100_000_000, 3_600_000, 100);
    expect(await fareText(page)).toMatch(/\d{5},\d{2} ₺/);
    await assertLayout(page);
    await page.screenshot({ path: `e2e/.shots/long-${w}x${h}.png` });

    await page.getByRole("button", { name: "BİTİR" }).click();
    await page.getByRole("button", { name: /Bitirmek için/ }).click();
    await assertLayout(page);
    await page.screenshot({ path: `e2e/.shots/ucret-${w}x${h}.png` });
  });
}
