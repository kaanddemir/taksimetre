import type { Tariff } from "../tariff/types.ts";
import { fareBreakdown, type FareBreakdown } from "./fare.ts";
import type { Measurement } from "./measurement.ts";
import { IDLE, transition, type ExtraCharge, type MeterCommand, type MeterState } from "./meter.ts";
import type { FarePolicy } from "./policy.ts";

/**
 * A modeled stretch of a future journey (possible fare-preview feature, no UI). The segment is charged as one
 * interval at its average speed, so callers must split routes into segments whose speed is
 * roughly uniform (e.g. per route step / traffic span). Totals alone are NOT enough for S mode.
 */
export interface Segment {
  distanceM: number;
  durationS: number;
}

/**
 * Converts segments into measurements. Cumulative values are rounded once to integer mm/ms,
 * so many fractional segments never drift.
 */
export function segmentsToMeasurements(segments: readonly Segment[], startAtMs = 0): Measurement[] {
  const out: Measurement[] = [];
  let cumM = 0;
  let cumS = 0;
  let prevMm = 0;
  for (const s of segments) {
    if (!Number.isFinite(s.distanceM) || !Number.isFinite(s.durationS) || s.distanceM < 0 || s.durationS < 0)
      throw new Error("segment distance and duration must be finite and non-negative");
    if (s.durationS === 0 && s.distanceM > 0) throw new Error("segment with distance needs a duration");
    cumM += s.distanceM;
    cumS += s.durationS;
    const mm = Math.round(cumM * 1000);
    const ms = Math.round(cumS * 1000);
    const speedKmh = s.durationS > 0 ? (s.distanceM / s.durationS) * 3.6 : 0;
    out.push({ atMs: startAtMs + ms, distanceMm: mm - prevMm, speedKmh });
    prevMm = mm;
  }
  return out;
}

export interface SimulationOptions {
  policy?: Partial<FarePolicy>;
  extras?: readonly ExtraCharge[];
  startAtMs?: number;
}

/**
 * Runs a whole journey through the same meter used live: start → measurements → extras → finalize.
 * Throws on any rejected command (simulations are programmer-controlled input).
 */
export function simulateJourney(tariff: Tariff, measurements: readonly Measurement[], opts: SimulationOptions = {}): FareBreakdown {
  const startAtMs = opts.startAtMs ?? 0;
  let state: MeterState = IDLE;
  const run = (cmd: MeterCommand) => {
    const r = transition(state, cmd);
    if (!r.ok) throw new Error(`${cmd.type} rejected: ${r.error} ${r.message}`);
    state = r.state;
  };
  run(opts.policy ? { type: "start", tariff, atMs: startAtMs, policy: opts.policy } : { type: "start", tariff, atMs: startAtMs });
  for (const m of measurements) run({ type: "measure", measurement: m });
  for (const c of opts.extras ?? []) run({ type: "addCharge", charge: c });
  const last = state.status === "MESGUL" ? state.journey.lastAtMs : startAtMs;
  run({ type: "finalize", atMs: last });
  if (state.status !== "UCRET") throw new Error("unreachable");
  return fareBreakdown(state.journey);
}

export function simulateSegments(tariff: Tariff, segments: readonly Segment[], opts: SimulationOptions = {}): FareBreakdown {
  return simulateJourney(tariff, segmentsToMeasurements(segments, opts.startAtMs ?? 0), opts);
}
