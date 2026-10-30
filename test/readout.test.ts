import { describe, expect, it } from "vitest";
import { readMeter } from "../src/engine/fare.ts";
import { IDLE, transition, type MeterCommand, type MeterState } from "../src/engine/meter.ts";
import { YELLOW } from "./helpers.ts";

function run(state: MeterState, ...cmds: MeterCommand[]): MeterState {
  for (const c of cmds) {
    const r = transition(state, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error}`);
    state = r.state;
  }
  return state;
}

describe("readout separates physical and chargeable quantities", () => {
  it("distance travelled while time-charging counts as physical distance only", () => {
    const s = run(
      IDLE,
      { type: "start", tariff: YELLOW, atMs: 0 },
      { type: "measure", measurement: { atMs: 60_000, distanceMm: 1_000_000, speedKmh: 60 } }, // 1 km fast
      { type: "measure", measurement: { atMs: 180_000, distanceMm: 200_000, speedKmh: 6 } }, // 200 m slow, 2 min
    );
    const r = readMeter(s);
    expect(r.totalDistanceMm).toBe(1_200_000); // physical
    expect(r.distanceModeMm).toBe(1_000_000); // accumulated for distance charging
    expect(r.totalDurationMs).toBe(180_000); // elapsed
    expect(r.slowDurationMs).toBe(120_000); // accumulated for time charging
    expect(r.meterFareKurus).toBe(7_194 + 10 * 480 + 2 * 998);
  });

  it("idle readout is all zero", () => {
    expect(readMeter(IDLE)).toMatchObject({ distanceModeMm: 0, totalDistanceMm: 0, mode: null });
  });
});
