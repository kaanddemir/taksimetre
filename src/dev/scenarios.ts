import type { Measurement } from "../engine/measurement.ts";

/** Synthetic driving profiles. Speeds only; no coordinates are fabricated. */
export interface Scenario {
  id: string;
  label: string;
  /** Speed in km/h at `t` seconds after the journey started. */
  speedAt(t: number): number;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: "normal", label: "Akıcı trafik (~45 km/h)", speedAt: (t) => 45 + 8 * Math.sin(t / 20) },
  { id: "slow", label: "Yavaş trafik (~8 km/h)", speedAt: (t) => 8 + 3 * Math.sin(t / 7) },
  { id: "stopgo", label: "Dur-kalk (30 s 30 km/h, 30 s dur)", speedAt: (t) => (t % 60 < 30 ? 30 : 0) },
  { id: "stationary", label: "Duran araç (0 km/h)", speedAt: () => 0 },
];

/**
 * Builds the normalized measurement for the interval (lastAtMs, nowMs]. The scenario speed at
 * the interval start is used for the whole interval and for its distance (mm = km/h ÷ 3.6 × ms).
 */
export function syntheticMeasurement(s: Scenario, startedAtMs: number, lastAtMs: number, nowMs: number): Measurement | null {
  const dt = nowMs - lastAtMs;
  if (dt <= 0) return null;
  const speedKmh = Math.max(0, s.speedAt((lastAtMs - startedAtMs) / 1000));
  return { atMs: nowMs, distanceMm: Math.round((speedKmh / 3.6) * dt), speedKmh };
}
