import { describe, expect, it } from "vitest";
import { simulateJourney, simulateSegments } from "../src/engine/simulate.ts";
import { ISTANBUL_TARIFFS } from "../src/tariff/istanbul.ts";
import { readings, repeat, YELLOW } from "./helpers.ts";

const meter = (steps: [number, number, number][], policy = {}) => simulateJourney(YELLOW, readings(steps), { policy });

// Expected values are computed by hand from the official unit fares:
// opening 71.94 TL, 4.80 TL / 100 m, 9.98 TL / min (yellow C). Model-assumption tests are labelled.
describe("S-mode calculation — official unit values", () => {
  it("opening fare only for a zero-length journey", () => {
    const f = meter([]);
    expect(f.meterFareKurus).toBe(7_194);
    expect(f.distanceSteps + f.timeSteps).toBe(0);
  });

  it("distance only: 10 km above crossover = 71.94 + 100 × 4.80", () => {
    const f = meter([[600_000, 10_000_000, 60]]);
    expect(f.distanceSteps).toBe(100);
    expect(f.timeSteps).toBe(0);
    expect(f.meterFareKurus).toBe(55_194);
  });

  it("time only: 15 min stationary = 71.94 + 15 × 9.98", () => {
    const f = meter([[900_000, 0, 0]]);
    expect(f.timeSteps).toBe(15);
    expect(f.meterFareKurus).toBe(22_164);
  });

  it("distance moved below crossover is not charged as distance", () => {
    const f = meter([[600_000, 1_000_000, 6]]); // 1 km in 10 min = 6 km/h
    expect(f.distanceSteps).toBe(0);
    expect(f.timeSteps).toBe(10);
  });

  it("10 km + 15 min slow traffic = 701.64 TL", () => {
    const f = meter([[600_000, 10_000_000, 60], [900_000, 500_000, 2]]);
    expect(f.meterFareKurus).toBe(70_164);
  });

  it("stop-and-go: 3 km at 40 km/h then 2.5 min stopped = 235.90 TL", () => {
    const f = meter([[270_000, 3_000_000, 40], [150_000, 0, 0]]);
    expect(f.distanceSteps).toBe(30);
    expect(f.timeSteps).toBe(2);
    expect(f.meterFareKurus).toBe(23_590);
  });

  it("exact 100 m boundary charges one step; 99.999 m charges none", () => {
    expect(meter([[10_000, 100_000, 36]]).distanceSteps).toBe(1);
    expect(meter([[10_000, 99_999, 36]]).distanceSteps).toBe(0);
    expect(meter([[10_000, 99_999, 36], [1, 1, 36]]).distanceSteps).toBe(1);
  });

  it("exact 60 s boundary charges one step; 59.999 s charges none", () => {
    expect(meter([[60_000, 0, 0]]).timeSteps).toBe(1);
    expect(meter([[59_999, 0, 0]]).timeSteps).toBe(0);
    expect(meter([[59_999, 0, 0], [1, 0, 0]]).timeSteps).toBe(1);
  });

  it("first increment only after the first full step (no free initial distance) [assumption]", () => {
    expect(meter([[5_000, 50_000, 36]]).meterFareKurus).toBe(7_194);
  });

  it("1,000 × 10 m equals one 10,000 m reading", () => {
    const many = meter(repeat(1_000, 1_000, 10_000, 36));
    const one = meter([[1_000_000, 10_000_000, 36]]);
    expect(many.distanceSteps).toBe(100);
    expect(many.meterFareKurus).toBe(one.meterFareKurus);
  });

  it("3,600 × 1 s equals one hour stationary (60 steps)", () => {
    expect(meter(repeat(3_600, 1_000, 0, 0)).timeSteps).toBe(60);
  });

  it("odd-sized readings lose nothing: 300 × 33.333 m + 0.1 m = exactly 100 steps", () => {
    const f = meter([...repeat(300, 1_000, 33_333, 120), [1_000, 100, 120]]); // 9,999.9 m + 0.1 m = 10 km
    expect(f.distanceSteps).toBe(100);
  });

  it("long journey: 120 km continuous", () => {
    const f = meter(repeat(120, 60_000, 1_000_000, 60));
    expect(f.distanceSteps).toBe(1_200);
    expect(f.meterFareKurus).toBe(7_194 + 1_200 * 480);
    expect(Number.isSafeInteger(f.totalKurus)).toBe(true);
  });

  it("all categories: 5 km + 5 min stopped = opening + 50 × unit dist + 5 × unit time", () => {
    for (const t of ISTANBUL_TARIFFS) {
      const f = simulateJourney(t, readings([[300_000, 5_000_000, 60], [300_000, 0, 0]]));
      expect(f.meterFareKurus).toBe(t.openingFareKurus + 50 * t.distanceStepFareKurus + 5 * t.timeStepFareKurus);
    }
  });

  it("is deterministic", () => {
    const steps = repeat(500, 1_700, 9_137, 19.3).concat(repeat(200, 900, 0, 0));
    expect(meter(steps)).toEqual(meter(steps));
  });
});

describe("S-mode calculation — model assumptions (policy)", () => {
  it("crossover boundary: exactly 12.50 km/h charges distance by default", () => {
    expect(meter([[28_800, 100_000, 12.5]]).distanceSteps).toBe(1); // 100 m in 28.8 s = 12.5 km/h
    expect(meter([[28_800, 100_000, 12.5]], { atCrossover: "time" }).distanceSteps).toBe(0);
    expect(meter([[60_000, 100_000, 12.49]]).timeSteps).toBe(1);
  });

  it("partial steps carry over mode switches by default", () => {
    // 60 m moving, 40 s stopped, 40 m moving, 20 s stopped -> 1 distance step + 1 time step
    const steps: [number, number, number][] = [[4_000, 60_000, 54], [40_000, 0, 0], [3_000, 40_000, 48], [20_000, 0, 0]];
    const carried = meter(steps);
    expect([carried.distanceSteps, carried.timeSteps]).toEqual([1, 1]);
    const reset = meter(steps, { carryPartialSteps: false });
    expect([reset.distanceSteps, reset.timeSteps]).toEqual([0, 0]);
  });
});

describe("synthetic segments (fare preview input)", () => {
  it("segments reuse the meter: 2 km free flow + 1 km in 6 min", () => {
    const f = simulateSegments(YELLOW, [
      { distanceM: 2_000, durationS: 120 }, // 60 km/h -> 20 distance steps
      { distanceM: 1_000, durationS: 360 }, // 10 km/h -> 6 time steps
    ]);
    expect([f.distanceSteps, f.timeSteps]).toEqual([20, 6]);
  });

  it("fractional segments do not drift (cumulative rounding)", () => {
    const segs = Array.from({ length: 3_000 }, () => ({ distanceM: 10 / 3, durationS: 0.1 }));
    expect(simulateSegments(YELLOW, segs).distanceSteps).toBe(100);
  });

  it("rejects invalid segments", () => {
    expect(() => simulateSegments(YELLOW, [{ distanceM: -1, durationS: 1 }])).toThrow();
    expect(() => simulateSegments(YELLOW, [{ distanceM: 10, durationS: 0 }])).toThrow();
  });
});
