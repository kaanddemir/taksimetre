/**
 * One normalized reading, produced by the GPS layer or a route model.
 * Readings are timestamp-based: the interval charged is (previous atMs, atMs].
 */
export interface Measurement {
  /** Monotonic timestamp in integer milliseconds (e.g. performance.now() rounded). Must not decrease. */
  atMs: number;
  /** Integer millimetres travelled since the previous reading (incremental, not cumulative). */
  distanceMm: number;
  /** Representative speed for the whole interval in km/h. It alone decides distance vs time charging. */
  speedKmh: number;
}

/** Limits that reject corrupt input rather than truncate it. */
export const LIMITS = Object.freeze({
  maxIntervalMs: 6 * 60 * 60 * 1000, // a single gap longer than 6 h is rejected
  maxDistanceMm: 100_000_000, // 100 km in one reading
  maxSpeedKmh: 300,
  maxJourneyMs: 48 * 60 * 60 * 1000,
  maxJourneyMm: 5_000_000_000, // 5,000 km
});

export type MeasurementError =
  | "INVALID_NUMBER"
  | "NEGATIVE_VALUE"
  | "OUT_OF_ORDER"
  | "OUT_OF_RANGE"
  | "DISTANCE_WITHOUT_TIME";

/** Returns an error code, or null if the reading is acceptable after a reading at `lastAtMs`. */
export function checkMeasurement(m: Measurement, lastAtMs: number): MeasurementError | null {
  if (typeof m !== "object" || m === null) return "INVALID_NUMBER";
  const { atMs, distanceMm, speedKmh } = m;
  if (!Number.isSafeInteger(atMs) || !Number.isSafeInteger(distanceMm)) return "INVALID_NUMBER";
  if (typeof speedKmh !== "number" || !Number.isFinite(speedKmh)) return "INVALID_NUMBER";
  if (distanceMm < 0 || speedKmh < 0) return "NEGATIVE_VALUE";
  if (atMs < lastAtMs) return "OUT_OF_ORDER";
  const dt = atMs - lastAtMs;
  if (dt > LIMITS.maxIntervalMs || distanceMm > LIMITS.maxDistanceMm || speedKmh > LIMITS.maxSpeedKmh) return "OUT_OF_RANGE";
  if (dt === 0 && distanceMm > 0) return "DISTANCE_WITHOUT_TIME";
  return null;
}
