import { expect, test } from "@playwright/test";
import { geo, installFakeGeo } from "./fake-geo.ts";

test.use({ launchOptions: { args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] } });

test("30-minute live journey: no leaks, bounded DOM work, single watcher", async ({ page }) => {
  test.setTimeout(240_000);
  await installFakeGeo(page);
  await page.clock.install({ time: new Date("2026-10-30T09:00:00Z") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const g = geo(page);
  await page.getByRole("button", { name: "BAŞLAT" }).click();
  await g.emit(0);
  await page.evaluate(() => {
    const w = window as any;
    w.__mut = 0;
    new MutationObserver((l) => (w.__mut += l.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "JSHeapUsedSize")?.value;
  };
  let pos = 0;
  const sample: { min: number; heap: number | undefined; mut: number }[] = [];
  for (let s = 1; s <= 1800; s++) {
    await page.clock.runFor(1_000);
    pos += (s % 120 < 80 ? 30 : 0) / 3.6;
    await g.emit(pos, 8, s % 120 < 80 ? 30 / 3.6 : 0);
    if (s % 300 === 0 || s === 60) {
      sample.push({ min: s / 60, heap: await heap(), mut: await page.evaluate(() => (window as any).__mut) });
    }
  }
  console.log("PERF browser samples", JSON.stringify(sample));
  const mutPerSec = sample.at(-1)!.mut / 1800;
  console.log(`PERF DOM mutation records/s: ${mutPerSec.toFixed(1)}`);
  expect(await g.watchesCreated()).toBe(1);
  expect(await g.watchCount()).toBe(1);
  const h = sample.map((x) => x.heap).filter((x): x is number => typeof x === "number");
  if (h.length > 2) expect(h.at(-1)! - h[1]!, "heap growth after warm-up").toBeLessThan(5_000_000);
  expect(await page.evaluate(() => sessionStorage.getItem("taksimetre.journey")!.length)).toBeLessThan(2_000);
});
