import type { Page } from "@playwright/test";

/**
 * Replaces navigator.geolocation / permissions / document.hidden before the app loads.
 * window.__geo.emit(northMetres, accuracy, speed) delivers a fix to every watcher.
 */
export async function installFakeGeo(page: Page, mode: "grant" | "deny" = "grant"): Promise<void> {
  await page.addInitScript((m) => {
    const LAT0 = 41.0369, LON0 = 28.985, M = (6371008.8 * Math.PI) / 180;
    const watches = new Map<number, [PositionCallback, PositionErrorCallback]>();
    let next = 1;
    let hidden = false;
    const g = {
      mode: m,
      watchesCreated: 0,
      probes: 0,
      get watchCount() { return watches.size; },
      emit(north: number, accuracy = 8, speed: number | null = null) {
        const p = { timestamp: Date.now(), coords: { latitude: LAT0 + north / M, longitude: LON0, accuracy, speed, altitude: null, altitudeAccuracy: null, heading: null } };
        for (const [ok] of [...watches.values()]) ok(p as unknown as GeolocationPosition);
      },
      setHidden(h: boolean) { hidden = h; document.dispatchEvent(new Event("visibilitychange")); },
    };
    (window as any).__geo = g;
    const deny = (err: PositionErrorCallback) => setTimeout(() => err({ code: 1, message: "denied" } as GeolocationPositionError), 10);
    const fake = {
      watchPosition(ok: PositionCallback, err: PositionErrorCallback) {
        const id = next++;
        g.watchesCreated++;
        if (g.mode === "deny") deny(err);
        else watches.set(id, [ok, err]);
        return id;
      },
      clearWatch(id: number) { watches.delete(id); },
      getCurrentPosition(_ok: PositionCallback, err: PositionErrorCallback) {
        g.probes++;
        if (g.mode === "deny") deny(err);
      },
    };
    Object.defineProperty(navigator, "geolocation", { value: fake, configurable: true });
    Object.defineProperty(navigator, "permissions", { value: { query: async () => ({ state: g.mode === "grant" ? "granted" : "denied" }) }, configurable: true });
    Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true });
  }, mode);
}

export const geo = (page: Page) => ({
  emit: (north: number, acc = 8, speed: number | null = null) => page.evaluate(([n, a, s]) => (window as any).__geo.emit(n, a, s), [north, acc, speed] as const),
  watchCount: () => page.evaluate(() => (window as any).__geo.watchCount as number),
  watchesCreated: () => page.evaluate(() => (window as any).__geo.watchesCreated as number),
  setHidden: (h: boolean) => page.evaluate((x) => (window as any).__geo.setHidden(x), h),
});

/** Drives `seconds` of travel at `kmh`, one fix per second, starting at `from` metres. Returns the end position. */
export async function drive(page: Page, from: number, seconds: number, kmh: number): Promise<number> {
  const g = geo(page);
  let pos = from;
  for (let i = 0; i < seconds; i++) {
    await page.clock.runFor(1_000);
    pos += kmh / 3.6;
    await g.emit(pos, 8, kmh / 3.6);
  }
  return pos;
}
