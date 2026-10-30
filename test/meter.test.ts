import { describe, expect, it } from "vitest";
import { payable, readMeter } from "../src/engine/fare.ts";
import { IDLE, transition, type MeterCommand, type MeterState } from "../src/engine/meter.ts";
import { tariff, YELLOW } from "./helpers.ts";

function run(state: MeterState, ...cmds: MeterCommand[]): MeterState {
  for (const c of cmds) {
    const r = transition(state, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error}`);
    state = r.state;
  }
  return state;
}
const start: MeterCommand = { type: "start", tariff: YELLOW, atMs: 1_000 };
const move = (atMs: number, distanceMm: number, speedKmh = 50): MeterCommand => ({ type: "measure", measurement: { atMs, distanceMm, speedKmh } });

describe("meter state machine", () => {
  it("SERBEST → MESGUL → UCRET → SERBEST", () => {
    let s = run(IDLE, start);
    expect(s.status).toBe("MESGUL");
    expect(readMeter(s).meterFareKurus).toBe(7_194);
    s = run(s, move(61_000, 500_000), { type: "finalize", atMs: 61_000 });
    expect(s.status).toBe("UCRET");
    s = run(s, { type: "clear", atMs: 71_000 });
    expect(s).toEqual(IDLE);
  });

  it("opening fare applied exactly once; duplicate start rejected", () => {
    const s = run(IDLE, start);
    const r = transition(s, start);
    expect(r.ok).toBe(false);
    expect(r.state).toBe(s);
    expect(readMeter(r.state).meterFareKurus).toBe(7_194);
  });

  it("rejects measurements while idle or finalized", () => {
    expect(transition(IDLE, move(10, 0)).ok).toBe(false);
    const fin = run(IDLE, start, { type: "finalize", atMs: 1_000 });
    const r = transition(fin, move(5_000, 100_000));
    expect(r.ok).toBe(false);
    expect(readMeter(r.state).totalDistanceMm).toBe(0);
  });

  it("duplicate finalize is rejected and does not change the fare", () => {
    const fin = run(IDLE, start, move(11_000, 300_000), { type: "finalize", atMs: 11_000 });
    const r = transition(fin, { type: "finalize", atMs: 12_000 });
    expect(r.ok).toBe(false);
    expect(r.state).toBe(fin);
  });

  it("cannot reset an active journey (clear only from UCRET)", () => {
    const s = run(IDLE, start);
    expect(transition(s, { type: "clear", atMs: 999_999 }).error).toBe("INVALID_TRANSITION");
    expect(transition(IDLE, { type: "clear", atMs: 0 }).ok).toBe(false);
  });

  it("final fare must stay displayed for the minimum display time [assumption: 10 s]", () => {
    const fin = run(IDLE, start, { type: "finalize", atMs: 5_000 });
    expect(transition(fin, { type: "clear", atMs: 14_999 }).error).toBe("DISPLAY_TIME_NOT_ELAPSED");
    expect(transition(fin, { type: "clear", atMs: 15_000 }).ok).toBe(true);
  });

  it("resume from UCRET continues the same journey without charging the paused time", () => {
    let s = run(IDLE, start, move(61_000, 0, 0), { type: "finalize", atMs: 61_000 });
    s = run(s, { type: "resume", atMs: 600_000 });
    expect(s.status).toBe("MESGUL");
    s = run(s, move(660_000, 0, 0), { type: "finalize", atMs: 660_000 });
    expect(payable(s)?.timeSteps).toBe(2);
    expect(transition(IDLE, { type: "resume", atMs: 0 }).ok).toBe(false);
  });

  it("tariff is fixed for the journey even if the caller mutates its object", () => {
    const mutable = { ...tariff("yellow-c"), reference: { ...YELLOW.reference } };
    let s = run(IDLE, { type: "start", tariff: mutable, atMs: 0 });
    mutable.distanceStepFareKurus = 9_999;
    s = run(s, move(60_000, 1_000_000));
    expect(readMeter(s).meterFareKurus).toBe(7_194 + 10 * 480);
    expect(readMeter(s).tariffId).toBe(YELLOW.id);
  });

  it("rejects an invalid tariff at start", () => {
    expect(transition(IDLE, { type: "start", tariff: { ...YELLOW, openingFareKurus: -5 }, atMs: 0 }).error).toBe("INVALID_TARIFF");
  });

  it("readout reports the current mode and slow time", () => {
    const s = run(IDLE, start, move(11_000, 200_000, 72), move(41_000, 0, 0));
    const r = readMeter(s);
    expect(r.mode).toBe("time");
    expect(r.slowDurationMs).toBe(30_000);
    expect(r.totalDurationMs).toBe(40_000);
  });
});

describe("measurement validation", () => {
  const active = run(IDLE, start);
  const err = (atMs: number, distanceMm: number, speedKmh: number) => transition(active, move(atMs, distanceMm, speedKmh)).error;
  it("rejects bad numbers", () => {
    expect(err(Number.NaN, 0, 0)).toBe("INVALID_NUMBER");
    expect(err(2_000, 1.5, 10)).toBe("INVALID_NUMBER");
    expect(err(2_000, 0, Number.POSITIVE_INFINITY)).toBe("INVALID_NUMBER");
  });
  it("rejects negatives", () => {
    expect(err(2_000, -1, 10)).toBe("NEGATIVE_VALUE");
    expect(err(2_000, 0, -3)).toBe("NEGATIVE_VALUE");
  });
  it("rejects out-of-order readings", () => {
    expect(err(500, 0, 0)).toBe("OUT_OF_ORDER");
  });
  it("rejects out-of-range values", () => {
    expect(err(1_000 + 6 * 3_600_000 + 1, 0, 0)).toBe("OUT_OF_RANGE");
    expect(err(2_000, 100_000_001, 10)).toBe("OUT_OF_RANGE");
    expect(err(2_000, 10, 301)).toBe("OUT_OF_RANGE");
  });
  it("zero-duration reading: allowed without distance, rejected with distance", () => {
    expect(transition(active, move(1_000, 0, 0)).ok).toBe(true);
    expect(err(1_000, 10, 0)).toBe("DISTANCE_WITHOUT_TIME");
  });
  it("rejects journeys beyond the supported limits", () => {
    let s = active;
    for (let i = 1; i <= 8; i++) s = run(s, move(1_000 + i * 6 * 3_600_000, 0, 0));
    expect(transition(s, move(1_000 + 8 * 6 * 3_600_000 + 1_000, 0, 0)).error).toBe("JOURNEY_LIMIT");
  });
});
