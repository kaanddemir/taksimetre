import { describe, expect, it } from "vitest";
import { fareBreakdown, readMeter } from "../src/engine/fare.ts";
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
const start: MeterCommand = { type: "start", tariff: YELLOW, atMs: 0 };

describe("gap command: unknown intervals are recorded, never charged", () => {
  it("advances the baseline without charging distance or time", () => {
    const s = run(IDLE, start, { type: "measure", measurement: { atMs: 60_000, distanceMm: 0, speedKmh: 0 } }, { type: "gap", atMs: 600_000 });
    const r = readMeter(s);
    expect(r.meterFareKurus).toBe(7_194 + 998); // only the measured minute
    expect(r.unknownDurationMs).toBe(540_000);
    expect(r.gapCount).toBe(1);
    expect(r.totalDurationMs).toBe(60_000);
    expect(s.status === "MESGUL" && s.journey.lastAtMs).toBe(600_000);
  });

  it("measurement after a gap covers only the interval after it", () => {
    const s = run(IDLE, start, { type: "gap", atMs: 300_000 }, { type: "measure", measurement: { atMs: 360_000, distanceMm: 0, speedKmh: 0 } });
    expect(readMeter(s).meterFareKurus).toBe(7_194 + 998);
  });

  it("zero-length gap is a no-op and is not counted", () => {
    const s = run(IDLE, start, { type: "gap", atMs: 0 });
    expect(readMeter(s)).toMatchObject({ gapCount: 0, unknownDurationMs: 0 });
  });

  it("rejects gaps outside MESGUL, backwards or invalid", () => {
    expect(transition(IDLE, { type: "gap", atMs: 5 }).error).toBe("INVALID_TRANSITION");
    const s = run(IDLE, start, { type: "measure", measurement: { atMs: 10_000, distanceMm: 0, speedKmh: 0 } });
    expect(transition(s, { type: "gap", atMs: 5_000 }).error).toBe("INVALID_TIME");
    expect(transition(s, { type: "gap", atMs: 1.5e4 + 0.5 }).error).toBe("INVALID_TIME");
  });

  it("partial step remainders survive a gap (no step is created or lost)", () => {
    const s = run(
      IDLE,
      start,
      { type: "measure", measurement: { atMs: 30_000, distanceMm: 0, speedKmh: 0 } },
      { type: "gap", atMs: 100_000 },
      { type: "measure", measurement: { atMs: 130_000, distanceMm: 0, speedKmh: 0 } },
    );
    expect(readMeter(s).meterFareKurus).toBe(7_194 + 998); // 30 s + 30 s = one minute
  });

  it("breakdown reports interruptions for the final summary", () => {
    const s = run(IDLE, start, { type: "gap", atMs: 90_000 }, { type: "finalize", atMs: 90_000 });
    expect(s.status === "UCRET" && fareBreakdown(s.journey)).toMatchObject({ gapCount: 1, unknownDurationMs: 90_000 });
  });
});
