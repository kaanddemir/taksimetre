import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payable, readMeter } from "../src/engine/fare.ts";
import { LiveJourney, type LiveDeps } from "../src/gps/live.ts";
import type { WakeLockApi } from "../src/gps/wake-lock.ts";
import { ISTANBUL_TARIFFS } from "../src/tariff/istanbul.ts";
import { ManualClock } from "../src/ui/clock.ts";
import { MeterStore } from "../src/ui/store.ts";
import { EPOCH0, FakeGeo } from "./gps-helpers.ts";

class FakeWake implements WakeLockApi {
  requests = 0;
  held = 0;
  reject = false;
  /** Simulates the browser releasing the lock (e.g. page hidden). */
  browserRelease = () => {};
  async request() {
    this.requests++;
    if (this.reject) throw new Error("NotAllowedError");
    this.held++;
    let onRelease = () => {};
    return {
      release: async () => { this.held--; onRelease(); },
      addEventListener: (_: "release", fn: () => void) => {
        onRelease = fn;
        this.browserRelease = () => { this.held--; fn(); };
      },
    };
  }
}

function setup(over: Partial<LiveDeps> = {}) {
  const clock = new ManualClock(10_000);
  const geo = new FakeGeo();
  const wake = new FakeWake();
  const store = new MeterStore(clock, ISTANBUL_TARIFFS, () => "2026-10-30");
  let hidden = false;
  let visFn = () => {};
  const live = new LiveJourney({
    store, clock, geo, wakeLock: wake,
    isHidden: () => hidden,
    onVisibilityChange: (fn) => { visFn = fn; return () => {}; },
    wallNow: () => EPOCH0 + clock.now(),
    ...over,
  });
  /** Advance app clock and timers together. */
  const adv = (ms: number) => { clock.advance(ms); vi.advanceTimersByTime(ms); };
  /** Position `north` metres from origin, received now. */
  const at = (north: number, acc = 8, speed: number | null = null) => geo.emit(EPOCH0 + clock.now(), north, acc, speed);
  const setHidden = (h: boolean) => { hidden = h; visFn(); };
  const fare = () => readMeter(store.get().meter).meterFareKurus;
  const finish = () => { store.requestFinish(); store.requestFinish(); };
  return { clock, geo, wake, store, live, adv, at, setHidden, fare, finish };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("start and acquisition", () => {
  it("meter starts only at the first usable fix; nothing charged while acquiring", () => {
    const t = setup();
    t.live.start();
    expect(t.store.get()).toMatchObject({ gps: "acquiring", meter: { status: "SERBEST" } });
    t.adv(20_000);
    t.at(0, 80); // too inaccurate: still acquiring
    expect(t.store.get().meter.status).toBe("SERBEST");
    t.adv(1_000);
    t.at(0);
    const s = t.store.get();
    expect(s).toMatchObject({ gps: "live", meter: { status: "MESGUL" } });
    expect(s.meter.status === "MESGUL" && s.meter.journey.startedAtMs).toBe(31_000);
    expect(t.fare()).toBe(7_194);
  });

  it("repeated start creates one watcher", () => {
    const t = setup();
    t.live.start();
    t.live.start();
    expect(t.geo.watches.size).toBe(1);
    t.at(0);
    t.live.start();
    expect(t.geo.watches.size).toBe(1);
  });

  it("permission denied: no journey, watcher cleared", () => {
    const t = setup();
    t.live.start();
    t.geo.error(1);
    expect(t.store.get()).toMatchObject({ gps: "denied", meter: { status: "SERBEST" } });
    expect(t.geo.watches.size).toBe(0);
  });

  it("position unavailable: no journey", () => {
    const t = setup();
    t.live.start();
    t.geo.error(2);
    expect(t.store.get()).toMatchObject({ gps: "unavailable", meter: { status: "SERBEST" } });
  });

  it("acquisition times out after 30 s; browser timeouts before that are tolerated", () => {
    const t = setup();
    t.live.start();
    t.geo.error(3);
    expect(t.store.get().gps).toBe("acquiring");
    t.adv(30_000);
    expect(t.store.get()).toMatchObject({ gps: "timeout", meter: { status: "SERBEST" } });
    expect(t.geo.watches.size).toBe(0);
  });

  it("cancel during acquisition stops everything", () => {
    const t = setup();
    t.live.start();
    t.live.cancel();
    expect(t.geo.watches.size).toBe(0);
    t.at(0);
    expect(t.store.get().meter.status).toBe("SERBEST");
  });

  it("unsupported browser cannot start", () => {
    const clock = new ManualClock();
    const store = new MeterStore(clock, ISTANBUL_TARIFFS, () => "2026-10-30");
    const live = new LiveJourney({ store, clock, geo: null });
    live.start();
    expect(store.get()).toMatchObject({ gps: "unsupported", meter: { status: "SERBEST" } });
  });
});

describe("live journey", () => {
  it("movement → distance charge; stationary fixes → waiting charge", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    for (let i = 1; i <= 20; i++) { t.adv(1_000); t.at(i * 15, 8, 15); } // 300 m at 54 km/h
    expect(t.fare()).toBe(7_194 + 3 * 480);
    for (let i = 0; i < 120; i++) { t.adv(1_000); t.at(300, 8, 0); }
    expect(readMeter(t.store.get().meter).mode).toBe("time");
    expect(t.fare()).toBeGreaterThanOrEqual(7_194 + 3 * 480 + 1 * 998);
  });

  it("stop-and-go matches the engine fed with the same processed measurements", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    let pos = 0;
    for (let c = 0; c < 5; c++) {
      for (let i = 0; i < 30; i++) { t.adv(1_000); pos += 8.3; t.at(pos, 8, 8.3); }
      for (let i = 0; i < 30; i++) { t.adv(1_000); t.at(pos, 8, 0); }
    }
    const m = readMeter(t.store.get().meter);
    expect(m.totalDistanceMm).toBeGreaterThan(1_200_000);
    expect(m.slowDurationMs).toBeGreaterThan(100_000);
    expect(m.totalDurationMs).toBe(300_000);
  });

  it("finish stops the watcher, releases wake lock and freezes the fare", async () => {
    const t = setup();
    t.live.start();
    t.at(0);
    await vi.runOnlyPendingTimersAsync();
    expect(t.wake.held).toBe(1);
    t.adv(1_000); t.at(15, 8, 15);
    t.finish();
    await Promise.resolve();
    expect(t.store.get()).toMatchObject({ gps: "off", meter: { status: "UCRET" } });
    expect(t.geo.watches.size).toBe(0);
    expect(t.wake.held).toBe(0);
    const f = t.fare();
    t.at(500);
    expect(t.fare()).toBe(f);
  });

  it("resume reacquires; finalized time and stale position are not charged; no second opening", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    for (let i = 1; i <= 10; i++) { t.adv(1_000); t.at(i * 15, 8, 15); }
    t.finish();
    const before = t.fare();
    t.adv(600_000);
    t.live.resume();
    expect(t.store.get()).toMatchObject({ gps: "acquiring", meter: { status: "UCRET" } });
    t.at(5_000); // far away: becomes the new baseline, not distance
    expect(t.store.get().meter.status).toBe("MESGUL");
    expect(t.fare()).toBe(before);
    expect(readMeter(t.store.get().meter).totalDistanceMm).toBe(150_000);
  });

  it("clear → new journey starts from a fresh baseline", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    t.finish();
    t.adv(10_000);
    t.store.clear();
    t.live.start();
    t.at(2_000); // new place, no distance from the previous journey
    expect(readMeter(t.store.get().meter)).toMatchObject({ meterFareKurus: 7_194, totalDistanceMm: 0 });
  });
});

describe("interruptions", () => {
  it("hidden page: fixes ignored, fresh baseline on return, gap recorded, no straight-line distance", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    t.adv(1_000); t.at(15, 8, 15);
    t.setHidden(true);
    expect(t.store.get().gps).toBe("interrupted");
    t.adv(60_000); t.at(900); // delivered while hidden: ignored
    t.adv(60_000);
    t.setHidden(false);
    expect(t.geo.watches.size).toBe(1); // a fresh watch, not a background probe
    t.at(2_000);
    const m = readMeter(t.store.get().meter);
    expect(m.totalDistanceMm).toBe(15_000);
    expect(m.unknownDurationMs).toBe(120_000);
    expect(m.gapCount).toBe(1);
    expect(t.store.get().gps).toBe("live");
    t.adv(1_000); t.at(2_015, 8, 15);
    expect(readMeter(t.store.get().meter).totalDistanceMm).toBe(30_000);
  });

  it("signal loss: weak after 5 s (probe), interrupted after 15 s, gap on recovery", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    t.adv(6_000);
    expect(t.store.get().gps).toBe("weak");
    expect(t.geo.probes.length).toBe(1);
    t.adv(10_000);
    expect(t.store.get().gps).toBe("interrupted");
    t.at(400);
    const m = readMeter(t.store.get().meter);
    expect(m).toMatchObject({ gapCount: 1, unknownDurationMs: 16_000, totalDistanceMm: 0 });
    expect(t.fare()).toBe(7_194);
  });

  it("delayed but in-range callbacks are measured, each interval once", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    for (const dt of [400, 4_000, 300, 9_000, 1_000]) { t.adv(dt); t.at(0, 8, 0); }
    const m = readMeter(t.store.get().meter);
    expect(m.totalDurationMs + m.unknownDurationMs).toBe(14_700);
    expect(m.gapCount).toBe(0);
  });

  it("permission revoked mid-journey → denied, reconnect restarts one watcher", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    t.geo.error(1);
    expect(t.store.get()).toMatchObject({ gps: "denied", meter: { status: "MESGUL" } });
    expect(t.geo.watches.size).toBe(0);
    t.live.reconnect();
    t.live.reconnect();
    expect(t.geo.watches.size).toBe(1);
    expect(t.store.get().gps).toBe("interrupted");
  });

  it("afterRestore reconnects silently only if permission is already granted", async () => {
    for (const granted of [true, false]) {
      const t = setup({ permissionGranted: async () => granted });
      t.live.start();
      t.at(0);
      t.geo.watches.clear(); // as after a reload: no watcher
      // simulate a fresh controller on the restored store
      const live2 = new LiveJourney({ store: t.store, clock: t.clock, geo: t.geo, permissionGranted: async () => granted, wallNow: () => EPOCH0 + t.clock.now() });
      await live2.afterRestore();
      expect(t.store.get().gps).toBe(granted ? "interrupted" : "stopped");
      expect(live2.watching).toBe(granted);
    }
  });
});

describe("race conditions", () => {
  it("a probe issued in an old tracking session cannot feed a new journey", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    t.adv(6_000); // quiet watcher → probe pending
    expect(t.geo.probes.length).toBe(1);
    t.finish();
    t.adv(10_000);
    t.store.clear();
    t.live.start(); // new watcher, acquiring
    const old = t.geo.probes[0]!;
    old.ok({ timestamp: EPOCH0 + t.clock.now(), coords: { latitude: 41.1, longitude: 29, accuracy: 5, speed: null } } as unknown as GeolocationPosition);
    expect(t.store.get()).toMatchObject({ gps: "acquiring", meter: { status: "SERBEST" } });
  });

  it("callbacks after finish never change the frozen fare", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    t.adv(6_000);
    t.finish();
    const f = t.fare();
    t.geo.probes[0]!.ok({ timestamp: EPOCH0 + t.clock.now(), coords: { latitude: 41.1, longitude: 29, accuracy: 5, speed: 20 } } as unknown as GeolocationPosition);
    expect(t.fare()).toBe(f);
    expect(t.store.get().meter.status).toBe("UCRET");
  });

  it("cancel then immediate start creates exactly one live watcher", () => {
    const t = setup();
    t.live.start();
    t.live.cancel();
    t.live.start();
    expect(t.geo.watches.size).toBe(1);
  });
});

describe("wake lock", () => {
  it("rejected request is not retried during the journey", async () => {
    const t = setup();
    t.wake.reject = true;
    t.live.start();
    t.at(0);
    await Promise.resolve();
    t.setHidden(true);
    t.setHidden(false);
    await Promise.resolve();
    expect(t.wake.requests).toBe(1);
  });

  it("re-requested when the page becomes visible again", async () => {
    const t = setup();
    t.live.start();
    t.at(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(t.wake.held).toBe(1);
    t.setHidden(true);
    t.wake.browserRelease();
    expect(t.wake.held).toBe(0);
    t.setHidden(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(t.wake.requests).toBe(2);
    expect(t.wake.held).toBe(1);
  });
});

describe("summary", () => {
  it("final breakdown reports interruptions", () => {
    const t = setup();
    t.live.start();
    t.at(0);
    t.adv(20_000);
    t.at(0);
    t.finish();
    expect(payable(t.store.get().meter)).toMatchObject({ gapCount: 1, unknownDurationMs: 20_000 });
  });
});

describe("foreground-only location acquisition", () => {
  it("clears watchers and timers while hidden, then starts only one fresh watcher", () => {
    const t = setup();
    t.live.start(); t.at(0);
    t.adv(1_000); t.at(15, 8, 15);
    const before = t.fare();
    const old = [...t.geo.watches.values()][0]!;
    t.setHidden(true); t.setHidden(true);
    expect(t.live.watching).toBe(false);
    expect(t.geo.watches.size).toBe(0);
    const probes = t.geo.probes.length;
    t.adv(120_000);
    old.ok({ timestamp: EPOCH0 + t.clock.now(), coords: { latitude: 42, longitude: 30, accuracy: 5, speed: 20 } } as GeolocationPosition);
    expect(t.geo.probes.length).toBe(probes);
    expect(t.fare()).toBe(before);
    t.setHidden(false); t.setHidden(false);
    expect(t.geo.watches.size).toBe(1);
    t.at(2_000);
    expect(readMeter(t.store.get().meter)).toMatchObject({ totalDistanceMm: 15_000, unknownDurationMs: 120_000, gapCount: 1 });
    expect(t.fare()).toBe(before);
    t.adv(1_000); t.at(2_015, 8, 15);
    expect(readMeter(t.store.get().meter).totalDistanceMm).toBe(30_000);
  });

  it("cancels acquisition while hidden without creating a journey or reopening a permission request", () => {
    const t = setup(); t.live.start();
    t.setHidden(true);
    expect(t.geo.watches.size).toBe(0);
    t.adv(60_000); t.setHidden(false); t.at(0);
    expect(t.geo.watches.size).toBe(0);
    expect(t.store.get().meter.status).toBe("SERBEST");
    expect(t.store.get().gps).toBe("off");
    t.live.start(); t.at(0);
    expect(t.store.get().meter.status).toBe("MESGUL");
  });

  it("does not restart a finished or permission-denied journey on visibility changes", () => {
    const t = setup(); t.live.start(); t.at(0);
    t.setHidden(true); t.finish(); t.setHidden(false);
    expect(t.geo.watches.size).toBe(0);
    expect(t.store.get().meter.status).toBe("UCRET");
    const denied = setup(); denied.live.start(); denied.at(0); denied.geo.error(1);
    denied.setHidden(true); denied.setHidden(false);
    expect(denied.geo.watches.size).toBe(0);
    expect(denied.store.get().gps).toBe("denied");
  });

  it("ignores old probe results after a hidden interval", () => {
    const t = setup(); t.live.start(); t.at(0); t.adv(6_000);
    const old = t.geo.probes[0]!;
    t.setHidden(true); t.adv(60_000); t.setHidden(false);
    old.ok({ timestamp: EPOCH0 + t.clock.now(), coords: { latitude: 42, longitude: 30, accuracy: 5, speed: 20 } } as GeolocationPosition);
    expect(readMeter(t.store.get().meter).totalDistanceMm).toBe(0);
    t.at(500);
    expect(readMeter(t.store.get().meter)).toMatchObject({ totalDistanceMm: 0, gapCount: 1, unknownDurationMs: 66_000 });
  });

  it("defers a granted restored watcher until visible, without duplicating watchers", async () => {
    const t = setup({ permissionGranted: async () => true });
    t.store.start(); t.setHidden(true);
    await t.live.afterRestore();
    expect(t.geo.watches.size).toBe(0);
    expect(t.store.get().meter.status).toBe("MESGUL");
    t.setHidden(false); t.setHidden(false);
    expect(t.geo.watches.size).toBe(1);
    t.at(1000);
    expect(readMeter(t.store.get().meter).totalDistanceMm).toBe(0);
  });
});
