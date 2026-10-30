import type { Tariff, TariffCategory } from "./types.ts";
import { isIsoDate } from "./validate.ts";

/** Istanbul has used fixed UTC+3 (no DST) since 2016. */
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Istanbul calendar date (YYYY-MM-DD) for an epoch-millisecond instant. */
export function istanbulDate(epochMs: number): string {
  return new Date(epochMs + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The version of `category` in force on `date` (YYYY-MM-DD, Istanbul local):
 * the one with the latest effectiveFrom that is ≤ date. Undefined if none is in force yet.
 */
export function selectTariff(
  tariffs: readonly Tariff[],
  category: TariffCategory,
  date: string,
): Tariff | undefined {
  if (!isIsoDate(date)) throw new Error(`Invalid date ${date}`);
  let best: Tariff | undefined;
  for (const t of tariffs) {
    if (t.category !== category || t.effectiveFrom > date) continue;
    if (!best || t.effectiveFrom > best.effectiveFrom) best = t;
  }
  return best;
}
