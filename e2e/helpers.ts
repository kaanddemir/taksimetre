import { expect, type Page } from "@playwright/test";

export const PORTRAIT = [[320, 568], [375, 667], [390, 844], [430, 932]] as const;
export const LANDSCAPE = [[667, 375], [844, 390], [932, 430]] as const;
export const SIZES = [...PORTRAIT, ...LANDSCAPE] as const;

/** Opens the dev app and waits for the simulator hook (dynamic import). */
export async function open(page: Page, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/?sim");
  await page.waitForFunction(() => "__sim" in window);
}

export const sim = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__sim[f as string](...(a as unknown[])), [fn, args] as const);

/** Accessible fare text, e.g. "Toplam ücret 71,94 ₺". */
export const fareText = (page: Page) => page.locator("#fare-text").textContent();

/** Feeds one reading through the real store via the dev clock (simulator must be paused). */
export async function feed(page: Page, distanceMm: number, durationMs: number, speedKmh: number): Promise<void> {
  expect(await sim(page, "feed", distanceMm, durationMs, speedKmh)).toBe(true);
}

/** The visible notice on the meter face (info line or warning label); count 0 when nothing is shown. */
export const notice = (page: Page) => page.locator(".notice-info:not([hidden]), .warn:not([hidden])");

/** Layout invariants that must hold at every size and state. */
export async function assertLayout(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    const se = document.scrollingElement!;
    const box = (sel: string) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect().toJSON() as DOMRect);
    return {
      vw, vh,
      scrollW: se.scrollWidth, scrollH: se.scrollHeight,
      items: box(".led-fare, .unit-tl, .legends, .tariff, .led-trip, .controls .key, .foot, .notice, .lang, .brand"),
      keys: box(".controls .key"),
      fare: box(".fare-row")[0]!,
      trip: box(".trip")[0]!,
      controls: box(".controls")[0]!,
    };
  });
  expect(r.scrollW, "horizontal overflow").toBeLessThanOrEqual(r.vw);
  expect(r.scrollH, "page scroll").toBeLessThanOrEqual(r.vh);
  for (const b of r.items) {
    expect(b.left).toBeGreaterThanOrEqual(-0.5);
    expect(b.top).toBeGreaterThanOrEqual(-0.5);
    expect(b.right).toBeLessThanOrEqual(r.vw + 0.5);
    expect(b.bottom).toBeLessThanOrEqual(r.vh + 0.5);
  }
  for (const k of r.keys) {
    expect(k.height).toBeGreaterThanOrEqual(44);
    expect(k.width).toBeGreaterThanOrEqual(44);
  }
  const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  expect(overlap(r.keys[0]!, r.keys[1]!), "keys overlap").toBe(false);
  expect(overlap(r.fare, r.controls), "fare overlaps controls").toBe(false);
  expect(overlap(r.trip, r.controls), "trip overlaps controls").toBe(false);
}
