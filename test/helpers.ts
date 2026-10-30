import { ISTANBUL_TARIFFS } from "../src/tariff/istanbul.ts";
import type { Tariff, TariffCategory } from "../src/tariff/types.ts";
import type { Measurement } from "../src/engine/measurement.ts";

export function tariff(category: TariffCategory): Tariff {
  const t = ISTANBUL_TARIFFS.find((x) => x.category === category);
  if (!t) throw new Error(category);
  return t;
}
export const YELLOW = tariff("yellow-c");

/** Builds incremental measurements from (durationMs, distanceMm, speedKmh) triples. */
export function readings(steps: [number, number, number][], start = 0): Measurement[] {
  let at = start;
  return steps.map(([dt, mm, v]) => ({ atMs: (at += dt), distanceMm: mm, speedKmh: v }));
}

/** Repeats one reading n times. */
export function repeat(n: number, dt: number, mm: number, v: number): [number, number, number][] {
  return Array.from({ length: n }, () => [dt, mm, v] as [number, number, number]);
}
