import type { Tariff } from "../tariff/types.ts";
import type { FarePolicy } from "./policy.ts";

export type ChargeMode = "distance" | "time";

/** Integer counters only: millimetres, milliseconds, whole steps. */
export interface Accumulator {
  distanceSteps: number;
  timeSteps: number;
  distanceRemainderMm: number; // progress toward the next distance step
  timeRemainderMs: number; // progress toward the next time step
  totalDistanceMm: number; // everything travelled while metering
  totalDurationMs: number; // everything elapsed while metering
  slowDurationMs: number; // time spent in time-charging mode
  distanceModeMm: number; // distance travelled while in distance-charging mode
  unknownDurationMs: number; // time with unknown motion (gaps), never charged
  gapCount: number; // number of recorded gaps
  lastMode: ChargeMode | null;
}

export const EMPTY_ACCUMULATOR: Readonly<Accumulator> = Object.freeze({
  distanceSteps: 0,
  timeSteps: 0,
  distanceRemainderMm: 0,
  timeRemainderMs: 0,
  totalDistanceMm: 0,
  totalDurationMs: 0,
  slowDurationMs: 0,
  distanceModeMm: 0,
  unknownDurationMs: 0,
  gapCount: 0,
  lastMode: null,
});

/** Mode for one interval. Speed is compared as km/h × 1000 against the integer m/h crossover. */
export function chargeModeFor(speedKmh: number, tariff: Tariff, policy: FarePolicy): ChargeMode {
  const metersPerHour = speedKmh * 1000;
  if (metersPerHour > tariff.crossoverMetersPerHour) return "distance";
  if (metersPerHour < tariff.crossoverMetersPerHour) return "time";
  return policy.atCrossover;
}

/**
 * S mode: the whole interval is charged either as distance or as time, never both.
 * Inputs must already be validated non-negative safe integers.
 */
export function accumulate(
  acc: Accumulator,
  tariff: Tariff,
  policy: FarePolicy,
  durationMs: number,
  distanceMm: number,
  mode: ChargeMode,
): Accumulator {
  const next = { ...acc };
  next.totalDistanceMm += distanceMm;
  next.totalDurationMs += durationMs;

  if (!policy.carryPartialSteps && acc.lastMode !== null && acc.lastMode !== mode) {
    if (mode === "distance") next.timeRemainderMs = 0;
    else next.distanceRemainderMm = 0;
  }
  next.lastMode = mode;

  if (mode === "distance") {
    const stepMm = tariff.distanceStepMeters * 1000;
    const total = next.distanceRemainderMm + distanceMm;
    next.distanceSteps += Math.floor(total / stepMm);
    next.distanceRemainderMm = total % stepMm;
    next.distanceModeMm += distanceMm;
  } else {
    const stepMs = tariff.timeStepSeconds * 1000;
    const total = next.timeRemainderMs + durationMs;
    next.timeSteps += Math.floor(total / stepMs);
    next.timeRemainderMs = total % stepMs;
    next.slowDurationMs += durationMs;
  }
  return next;
}

/** Running meter fare in kuruş: opening + whole steps. Never includes the minimum fare or extras. */
export function meterFareKurus(acc: Accumulator, tariff: Tariff): number {
  return (
    tariff.openingFareKurus +
    acc.distanceSteps * tariff.distanceStepFareKurus +
    acc.timeSteps * tariff.timeStepFareKurus
  );
}
