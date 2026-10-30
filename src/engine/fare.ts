import { meterFareKurus, type ChargeMode } from "./accumulator.ts";
import type { ExtraCharge, Journey, MeterState } from "./meter.ts";

/** Live readout for the meter display. Shows the running meter fare, never the minimum. */
export interface MeterReadout {
  status: MeterState["status"];
  tariffId: string | null;
  meterFareKurus: number;
  extrasKurus: number;
  mode: ChargeMode | null;
  /** Physical distance travelled while metering (the value to show as "km"). */
  totalDistanceMm: number;
  /** Part of totalDistanceMm travelled in distance-charging mode. */
  distanceModeMm: number;
  /** Elapsed metering time. */
  totalDurationMs: number;
  /** Part of totalDurationMs spent in time-charging mode. */
  slowDurationMs: number;
  /** Time with unknown motion (GPS gaps); not part of totalDurationMs and never charged. */
  unknownDurationMs: number;
  gapCount: number;
}

export function readMeter(state: MeterState): MeterReadout {
  if (state.status === "SERBEST")
    return { status: "SERBEST", tariffId: null, meterFareKurus: 0, extrasKurus: 0, mode: null, totalDistanceMm: 0, distanceModeMm: 0, totalDurationMs: 0, slowDurationMs: 0, unknownDurationMs: 0, gapCount: 0 };
  const { tariff, acc, extras } = state.journey;
  return {
    status: state.status,
    tariffId: tariff.id,
    meterFareKurus: meterFareKurus(acc, tariff),
    extrasKurus: sumExtras(extras),
    mode: acc.lastMode,
    totalDistanceMm: acc.totalDistanceMm,
    distanceModeMm: acc.distanceModeMm,
    totalDurationMs: acc.totalDurationMs,
    slowDurationMs: acc.slowDurationMs,
    unknownDurationMs: acc.unknownDurationMs,
    gapCount: acc.gapCount,
  };
}

/** Estimated amount to pay. All values in kuruş; total = baseFare + extras. */
export interface FareBreakdown {
  tariffId: string;
  openingKurus: number;
  distanceSteps: number;
  distanceKurus: number;
  timeSteps: number;
  timeKurus: number;
  meterFareKurus: number; // opening + distance + time
  minimumFareKurus: number;
  minimumApplied: boolean;
  baseFareKurus: number; // max(meterFare, minimum)
  extras: readonly ExtraCharge[];
  extrasKurus: number;
  totalKurus: number;
  /** Interruptions: uncharged time with unknown motion, so the estimate may be low. */
  gapCount: number;
  unknownDurationMs: number;
}

export function fareBreakdown(journey: Journey): FareBreakdown {
  const { tariff, acc, extras } = journey;
  const distanceKurus = acc.distanceSteps * tariff.distanceStepFareKurus;
  const timeKurus = acc.timeSteps * tariff.timeStepFareKurus;
  const meter = tariff.openingFareKurus + distanceKurus + timeKurus;
  const base = Math.max(meter, tariff.minimumFareKurus);
  const extrasKurus = sumExtras(extras);
  return {
    tariffId: tariff.id,
    openingKurus: tariff.openingFareKurus,
    distanceSteps: acc.distanceSteps,
    distanceKurus,
    timeSteps: acc.timeSteps,
    timeKurus,
    meterFareKurus: meter,
    minimumFareKurus: tariff.minimumFareKurus,
    minimumApplied: base > meter,
    baseFareKurus: base,
    extras,
    extrasKurus,
    totalKurus: base + extrasKurus,
    gapCount: acc.gapCount,
    unknownDurationMs: acc.unknownDurationMs,
  };
}

/** Payable breakdown, available only once the journey is finalized (UCRET). */
export function payable(state: MeterState): FareBreakdown | null {
  return state.status === "UCRET" ? fareBreakdown(state.journey) : null;
}

function sumExtras(extras: readonly ExtraCharge[]): number {
  return extras.reduce((s, e) => s + e.amountKurus, 0);
}

/** Formats kuruş as "1234.56" without floating-point arithmetic. */
export function formatKurus(kurus: number): string {
  const sign = kurus < 0 ? "-" : "";
  const abs = Math.abs(kurus);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
