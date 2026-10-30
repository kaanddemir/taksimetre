import { describe, expect, it } from "vitest";
import { IDLE, transition, type MeterState } from "../src/engine/meter.ts";
import { readMeter } from "../src/engine/fare.ts";
import { haversineM } from "../src/gps/geo.ts";
import { GpsProcessor, type RawFix } from "../src/gps/processor.ts";
import { fix, LAT0, LON0, M_PER_DEG_LAT, rng } from "./gps-helpers.ts";
import { YELLOW } from "./helpers.ts";

/** Pipes fixes through the processor into the real engine (same path as LiveJourney). */
function drive(fixes: RawFix[], p = new GpsProcessor()): MeterState {
  let s: MeterState = IDLE;
  for (const f of fixes) {
    const r = p.process(f);
    let cmd = null;
    if (r.kind === "baseline") cmd = s.status === "SERBEST" ? { type: "start" as const, tariff: YELLOW, atMs: r.atMs } : { type: "gap" as const, atMs: r.atMs };
    else if (r.kind === "measure") cmd = { type: "measure" as const, measurement: r.measurement };
    if (!cmd) continue;
    const res = transition(s, cmd);
    if (!res.ok) throw new Error(res.error);
    s = res.state;
  }
  return s;
}
const series = (n: number, dtMs: number, stepM: number, opts: Partial<RawFix> = {}) =>
  Array.from({ length: n }, (_, i) => fix(i * dtMs, i * stepM, opts));

describe("haversine", () => {
  it("one degree of latitude = R·π/180", () => {
    expect(haversineM(0, 0, 1, 0)).toBeCloseTo(M_PER_DEG_LAT, 3);
  });
  it("is symmetric and zero for identical points", () => {
    expect(haversineM(LAT0, LON0, LAT0, LON0)).toBe(0);
    expect(haversineM(41, 29, 41.01, 29.02)).toBeCloseTo(haversineM(41.01, 29.02, 41, 29), 9);
  });
  it("Taksim → Kadıköy pier ≈ 5.4 km straight line", () => {
    expect(haversineM(41.0369, 28.985, 40.9917, 29.0247) / 1000).toBeCloseTo(6.05, 1);
  });
});

describe("GPS processor", () => {
  it("first usable fix is a baseline, not a measurement", () => {
    expect(new GpsProcessor().process(fix(0, 0))).toEqual({ kind: "baseline", atMs: 0, afterGap: false });
  });

  it("stationary drift (±3 m jitter, 10 min) adds no distance and is charged as waiting", () => {
    const r = rng(7);
    const fixes = Array.from({ length: 600 }, (_, i) => ({ ...fix(i * 1000, 0, { accuracyM: 10 }), lat: LAT0 + (3 * r()) / M_PER_DEG_LAT, lon: LON0 + (3 * r()) / (M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180)) }));
    const m = readMeter(drive(fixes));
    expect(m.totalDistanceMm).toBe(0);
    expect(m.meterFareKurus).toBe(7_194 + 9 * 998); // 599 s measured → 9 full minutes
  });

  it("harsher drift (±5 m jitter at 15 m accuracy, 30 min) stays negligible", () => {
    const r = rng(99);
    const k = Math.cos((LAT0 * Math.PI) / 180);
    const fixes = Array.from({ length: 1800 }, (_, i) => ({ ...fix(i * 1000, 0, { accuracyM: 15 }), lat: LAT0 + (5 * r()) / M_PER_DEG_LAT, lon: LON0 + (5 * r()) / (M_PER_DEG_LAT * k) }));
    const m = readMeter(drive(fixes));
    expect(m.totalDistanceMm).toBeLessThan(20_000);
    expect(m.mode).toBe("time");
  });

  it("steady 54 km/h movement is credited in full and charged as distance", () => {
    const m = readMeter(drive(series(61, 1000, 15)));
    expect(m.totalDistanceMm).toBeGreaterThan(899_990);
    expect(m.totalDistanceMm).toBeLessThan(900_010);
    expect(m.meterFareKurus).toBe(7_194 + 9 * 480);
    expect(m.slowDurationMs).toBe(0);
  });

  it("crawling below minMovingKmh (8) is charged as time but not added to distance (drift guard)", () => {
    const m = readMeter(drive(series(101, 1000, 2, { accuracyM: 10 }))); // 200 m at 7.2 km/h
    expect(m.totalDistanceMm).toBe(0);
    expect(m.slowDurationMs).toBe(100_000);
    expect(m.meterFareKurus).toBe(7_194 + 998);
  });

  it("slow movement above minMovingKmh is credited, short by at most one threshold", () => {
    const m = readMeter(drive(series(101, 1000, 10 / 3.6, { accuracyM: 10 }))); // 278 m at 10 km/h
    expect(m.totalDistanceMm).toBeGreaterThanOrEqual(268_000);
    expect(m.totalDistanceMm).toBeLessThanOrEqual(278_000);
  });

  it("crossover: 10 km/h is time-charged, 20 km/h distance-charged", () => {
    expect(readMeter(drive(series(121, 1000, 10 / 3.6))).mode).toBe("time");
    const fast = readMeter(drive(series(121, 1000, 20 / 3.6)));
    expect(fast.mode).toBe("distance");
    expect(fast.slowDurationMs).toBeLessThanOrEqual(1_000);
  });

  it("rejects invalid coordinates and values", () => {
    const p = new GpsProcessor();
    expect(p.process({ ...fix(0, 0), lat: 91 }).kind).toBe("rejected");
    expect(p.process({ ...fix(0, 0), lon: Number.NaN }).kind).toBe("rejected");
    expect(p.process({ ...fix(0, 0), accuracyM: 0 }).kind).toBe("rejected");
    expect(p.process({ ...fix(0, 0), receivedAtMs: 0.5 })).toEqual({ kind: "rejected", reason: "invalid" });
  });

  it("rejects duplicate and out-of-order fixes", () => {
    const p = new GpsProcessor();
    p.process(fix(1000, 0));
    expect(p.process(fix(1000, 5))).toEqual({ kind: "rejected", reason: "duplicate" });
    expect(p.process(fix(500, 5))).toEqual({ kind: "rejected", reason: "duplicate" });
    expect(p.process({ ...fix(2000, 5), receivedAtMs: 900 })).toEqual({ kind: "rejected", reason: "duplicate" });
  });

  it("rejects stale (cached) and inaccurate fixes", () => {
    const p = new GpsProcessor();
    expect(p.process({ ...fix(0, 0), wallNowMs: fix(0, 0).wallNowMs + 11_000 })).toEqual({ kind: "rejected", reason: "stale" });
    expect(p.process(fix(0, 0, { accuracyM: 50 }))).toEqual({ kind: "rejected", reason: "inaccurate" });
  });

  it("rejects implausible jumps and recovers on the next sane fix", () => {
    const p = new GpsProcessor();
    p.process(fix(0, 0));
    expect(p.process(fix(1000, 1000))).toEqual({ kind: "rejected", reason: "jump" });
    const r = p.process(fix(2000, 20));
    expect(r.kind === "measure" && r.measurement.distanceMm).toBe(20_000);
  });

  it("uses plausible device speed, ignores missing/NaN/negative/absurd speed", () => {
    const p = new GpsProcessor();
    p.process(fix(0, 0));
    const a = p.process(fix(1000, 4, { speedMps: 10 }));
    expect(a.kind === "measure" && a.measurement.speedKmh).toBe(36);
    for (const bad of [null, Number.NaN, -1, 100]) {
      const q = new GpsProcessor();
      q.process(fix(0, 0));
      const r = q.process(fix(1000, 10, { speedMps: bad }));
      expect(r.kind === "measure" && r.measurement.speedKmh).toBe(36); // derived: 10 m / 1 s
    }
  });

  it("Doppler speed credits real movement under a large accuracy threshold", () => {
    const fixes = Array.from({ length: 21 }, (_, i) => fix(i * 1000, i * 3, { accuracyM: 30, speedMps: 3 }));
    const m = readMeter(drive(fixes)); // 60 m at 10.8 km/h, threshold 30 m
    expect(m.totalDistanceMm).toBeGreaterThanOrEqual(55_000);
  });

  it("phantom Doppler speed on a parked phone does not credit distance", () => {
    const r = rng(3);
    const fixes = Array.from({ length: 300 }, (_, i) => ({ ...fix(i * 1000, 0, { accuracyM: 10, speedMps: i % 5 ? 0 : 2.5 }), lat: LAT0 + (2 * r()) / M_PER_DEG_LAT }));
    expect(readMeter(drive(fixes)).totalDistanceMm).toBe(0);
  });

  it("an outlier after a long stop is rejected as a jump (checked against the last fix, not the anchor)", () => {
    const p = new GpsProcessor();
    for (let i = 0; i <= 120; i++) p.process(fix(i * 1000, 0));
    expect(p.process(fix(121_000, 80))).toEqual({ kind: "rejected", reason: "jump" });
  });

  it("smoothing: stopping from 50 km/h falls below 12.5 km/h within 3 s, not instantly", () => {
    const p = new GpsProcessor();
    for (let i = 0; i <= 10; i++) p.process(fix(i * 1000, i * 13.9, { speedMps: 13.9 }));
    const speeds = [11, 12, 13].map((i) => {
      const r = p.process(fix(i * 1000, 139, { speedMps: 0 }));
      return r.kind === "measure" ? r.measurement.speedKmh : -1;
    });
    expect(speeds[0]).toBeGreaterThan(12.5);
    expect(speeds[2]).toBeLessThan(12.5);
  });

  it("irregular callback intervals: each interval counted once, total time exact", () => {
    const times = [0, 300, 3000, 3100, 7000, 8000, 14_000];
    const m = readMeter(drive(times.map((t, i) => fix(t, i * 3))));
    expect(m.totalDurationMs + m.unknownDurationMs).toBe(14_000);
  });

  it("gap longer than 15 s: new baseline, no distance across it, recorded as unknown", () => {
    const fixes = [fix(0, 0), fix(1000, 15), fix(31_000, 2_000), fix(32_000, 2_015)];
    const m = readMeter(drive(fixes));
    expect(m.totalDistanceMm).toBe(30_000); // 15 m + 15 m, not the 1,985 m straight line
    expect(m.unknownDurationMs).toBe(30_000);
    expect(m.gapCount).toBe(1);
  });

  it("markInterrupted forces a fresh baseline", () => {
    const p = new GpsProcessor();
    p.process(fix(0, 0));
    p.markInterrupted();
    expect(p.lastUsableAtMs).toBeNull();
    expect(p.process(fix(2000, 500)).kind).toBe("baseline");
  });

  it("same fix sequence → same fare (deterministic)", () => {
    const r = rng(42);
    const fixes = Array.from({ length: 400 }, (_, i) => fix(i * 900 + Math.floor(r() * 200 + 200), i * (i % 40 < 20 ? 9 : 0.5) + r()));
    expect(readMeter(drive(fixes))).toEqual(readMeter(drive(fixes)));
  });
});
