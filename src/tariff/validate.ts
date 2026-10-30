import { TARIFF_CATEGORIES, type Tariff } from "./types.ts";

/** Upper bound for any single kuruş amount in a tariff (100,000 TL). */
const MAX_KURUS = 10_000_000;
/** Allowed relative gap between published unit fares and the published km/hour rates.
 *  Official 2026 values differ by up to ~0.17 % because the unit fares are rounded. */
const RATE_TOLERANCE = 0.02;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function positiveInt(v: number, max: number): boolean {
  return Number.isSafeInteger(v) && v > 0 && v <= max;
}

/** Returns a list of problems; an empty list means the tariff is valid. */
export function validateTariff(t: Tariff): string[] {
  const e: string[] = [];
  if (!t.id.trim()) e.push("id is empty");
  if (!TARIFF_CATEGORIES.includes(t.category)) e.push(`unknown category ${String(t.category)}`);
  if (!isIsoDate(t.effectiveFrom)) e.push("effectiveFrom is not a valid YYYY-MM-DD date");
  if (t.currency !== "TRY") e.push("currency must be TRY");

  const kurus: [string, number][] = [
    ["openingFareKurus", t.openingFareKurus],
    ["distanceStepFareKurus", t.distanceStepFareKurus],
    ["timeStepFareKurus", t.timeStepFareKurus],
    ["minimumFareKurus", t.minimumFareKurus],
    ["reference.perKmKurus", t.reference.perKmKurus],
    ["reference.perHourKurus", t.reference.perHourKurus],
  ];
  for (const [name, v] of kurus) if (!positiveInt(v, MAX_KURUS)) e.push(`${name} must be a positive integer kuruş amount`);
  if (!positiveInt(t.distanceStepMeters, 10_000)) e.push("distanceStepMeters must be a positive integer ≤ 10000");
  if (!positiveInt(t.timeStepSeconds, 3_600)) e.push("timeStepSeconds must be a positive integer ≤ 3600");
  if (!positiveInt(t.crossoverMetersPerHour, 200_000)) e.push("crossoverMetersPerHour must be a positive integer ≤ 200000");
  if (e.length) return e;

  if (t.minimumFareKurus < t.openingFareKurus) e.push("minimumFareKurus is below openingFareKurus");

  const near = (a: number, b: number) => Math.abs(a - b) / b <= RATE_TOLERANCE;
  const stepPerKm = (t.distanceStepFareKurus * 1000) / t.distanceStepMeters;
  const stepPerHour = (t.timeStepFareKurus * 3600) / t.timeStepSeconds;
  if (!near(stepPerKm, t.reference.perKmKurus)) e.push("distance step fare contradicts the published per-km rate");
  if (!near(stepPerHour, t.reference.perHourKurus)) e.push("time step fare contradicts the published hourly rate");
  const derivedCrossover = (t.reference.perHourKurus / t.reference.perKmKurus) * 1000;
  if (!near(t.crossoverMetersPerHour, derivedCrossover)) e.push("crossover speed contradicts hourly / per-km rates");

  if (!t.source.url.startsWith("https://")) e.push("source.url must be https");
  if (!isIsoDate(t.source.verifiedOn) || !isIsoDate(t.source.decisionDate)) e.push("source dates must be YYYY-MM-DD");
  return e;
}

export function assertValidTariff(t: Tariff): void {
  const errors = validateTariff(t);
  if (errors.length) throw new Error(`Invalid tariff ${t.id}: ${errors.join("; ")}`);
}

/** Validates every tariff plus registry-level rules (unique ids, one version per category and date). */
export function validateRegistry(tariffs: readonly Tariff[]): string[] {
  const e: string[] = [];
  const ids = new Set<string>();
  const slots = new Set<string>();
  for (const t of tariffs) {
    for (const m of validateTariff(t)) e.push(`${t.id}: ${m}`);
    if (ids.has(t.id)) e.push(`duplicate id ${t.id}`);
    ids.add(t.id);
    const slot = `${t.category}@${t.effectiveFrom}`;
    if (slots.has(slot)) e.push(`two versions of ${t.category} effective ${t.effectiveFrom}`);
    slots.add(slot);
  }
  return e;
}
