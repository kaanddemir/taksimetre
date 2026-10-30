import { LIMITS } from "../engine/measurement.ts";
import type { Accumulator } from "../engine/accumulator.ts";
import type { ExtraCharge, Journey, MeterState } from "../engine/meter.ts";
import type { FarePolicy } from "../engine/policy.ts";
import type { Tariff } from "../tariff/types.ts";
import { validateTariff } from "../tariff/validate.ts";

/**
 * Local journey recovery (sessionStorage: dies with the tab, never leaves the device).
 * Stores only meter state: no coordinates, no GPS history.
 */
export const STORAGE_KEY = "taksimetre.journey";
export const SCHEMA_VERSION = 1;
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;

interface Saved {
  v: number;
  savedAtEpochMs: number;
  savedAtMonoMs: number;
  status: "MESGUL" | "UCRET";
  tariffId: string;
  policy: FarePolicy;
  startedAtMs: number;
  lastAtMs: number;
  finalizedAtMs: number | null;
  acc: Accumulator;
  extras: ExtraCharge[];
}

/** JSON for the current state, or null when there is nothing to keep (SERBEST). */
export function serialize(state: MeterState, monoNow: number, epochNow: number): string | null {
  if (state.status === "SERBEST") return null;
  const j = state.journey;
  const saved: Saved = {
    v: SCHEMA_VERSION,
    savedAtEpochMs: epochNow,
    savedAtMonoMs: monoNow,
    status: state.status,
    tariffId: j.tariff.id,
    policy: { ...j.policy },
    startedAtMs: j.startedAtMs,
    lastAtMs: j.lastAtMs,
    finalizedAtMs: state.status === "UCRET" ? state.finalizedAtMs : null,
    acc: { ...j.acc },
    extras: j.extras.map((e) => ({ ...e })),
  };
  return JSON.stringify(saved);
}

export type RestoreResult =
  | { ok: true; meter: MeterState; unknownMs: number }
  | { ok: false; reason: "empty" | "corrupt" | "version" | "tariff" | "expired" };

const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const nonNeg = (v: unknown): v is number => int(v) && v >= 0;

/**
 * Validates saved JSON and rebases its monotonic timestamps onto the current page's clock.
 * MESGUL: the time the page was gone (plus the unsent tail before saving) is returned as
 * `unknownMs`; the meter's lastAtMs is placed at `monoNow - unknownMs` so the caller can record
 * it with a `gap` command. Nothing is charged for it.
 */
export function restore(json: string | null, tariffs: readonly Tariff[], monoNow: number, epochNow: number): RestoreResult {
  if (json === null) return { ok: false, reason: "empty" };
  let s: Saved;
  try {
    s = JSON.parse(json) as Saved;
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (typeof s !== "object" || s === null) return { ok: false, reason: "corrupt" };
  if (s.v !== SCHEMA_VERSION) return { ok: false, reason: "version" };
  const tariff = tariffs.find((t) => t.id === s.tariffId);
  if (!tariff || validateTariff(tariff).length) return { ok: false, reason: "tariff" };
  if (!validSaved(s, tariff)) return { ok: false, reason: "corrupt" };
  const downtime = epochNow - s.savedAtEpochMs;
  if (downtime < 0 || downtime > MAX_AGE_MS) return { ok: false, reason: "expired" };

  const sinceAnchor = s.status === "MESGUL" ? s.savedAtMonoMs - s.lastAtMs : s.savedAtMonoMs - s.finalizedAtMs!;
  const elapsed = Math.max(0, sinceAnchor) + downtime;
  if (!nonNeg(elapsed) || (s.status === "MESGUL" && s.acc.totalDurationMs + s.acc.unknownDurationMs + elapsed > LIMITS.maxJourneyMs)) {
    return { ok: false, reason: "expired" };
  }
  const anchorNew = monoNow - elapsed;
  const offset = anchorNew - (s.status === "MESGUL" ? s.lastAtMs : s.finalizedAtMs!);

  if (![s.startedAtMs + offset, s.lastAtMs + offset, ...(s.status === "UCRET" ? [s.finalizedAtMs! + offset] : [])].every(int)) {
    return { ok: false, reason: "corrupt" };
  }
  const journey: Journey = {
    tariff,
    policy: Object.freeze({ ...s.policy }),
    startedAtMs: s.startedAtMs + offset,
    lastAtMs: s.lastAtMs + offset,
    acc: { ...s.acc },
    extras: s.extras.map((e) => Object.freeze({ id: e.id, label: e.label, amountKurus: e.amountKurus })),
  };
  if (s.status === "MESGUL") return { ok: true, meter: { status: "MESGUL", journey }, unknownMs: elapsed };
  return { ok: true, meter: { status: "UCRET", journey, finalizedAtMs: s.finalizedAtMs! + offset }, unknownMs: 0 };
}

function validSaved(s: Saved, t: Tariff): boolean {
  if (s.status !== "MESGUL" && s.status !== "UCRET") return false;
  if (!int(s.savedAtEpochMs) || !int(s.savedAtMonoMs) || !int(s.startedAtMs) || !int(s.lastAtMs)) return false;
  if (s.lastAtMs < s.startedAtMs || s.savedAtMonoMs < s.lastAtMs) return false;
  // Rebased journey timestamps may legitimately be negative; their differences
  // must still be safe integers. Saved wall/page clocks themselves cannot be negative.
  if (!nonNeg(s.savedAtEpochMs) || !nonNeg(s.savedAtMonoMs) ||
      !nonNeg(s.lastAtMs - s.startedAtMs) || !nonNeg(s.savedAtMonoMs - s.startedAtMs)) return false;
  if (s.status === "MESGUL" && s.finalizedAtMs !== null) return false;
  if (s.status === "UCRET" && (!int(s.finalizedAtMs) || s.finalizedAtMs < s.lastAtMs || s.savedAtMonoMs < s.finalizedAtMs)) return false;
  const p = s.policy;
  if (typeof p !== "object" || p === null || typeof p.carryPartialSteps !== "boolean" || (p.atCrossover !== "distance" && p.atCrossover !== "time") || !nonNeg(p.minFareDisplayMs)) return false;
  const a = s.acc;
  if (typeof a !== "object" || a === null) return false;
  const fields: (keyof Accumulator)[] = ["distanceSteps", "timeSteps", "distanceRemainderMm", "timeRemainderMs", "totalDistanceMm", "totalDurationMs", "slowDurationMs", "distanceModeMm", "unknownDurationMs", "gapCount"];
  if (!fields.every((f) => nonNeg(a[f]))) return false;
  if (a.lastMode !== null && a.lastMode !== "distance" && a.lastMode !== "time") return false;
  if (a.distanceRemainderMm >= t.distanceStepMeters * 1000 || a.timeRemainderMs >= t.timeStepSeconds * 1000) return false;
  if (a.slowDurationMs > a.totalDurationMs || a.distanceModeMm > a.totalDistanceMm) return false;
  if (a.totalDistanceMm > LIMITS.maxJourneyMm || a.totalDurationMs + a.unknownDurationMs > LIMITS.maxJourneyMs) return false;
  if (a.totalDurationMs + a.unknownDurationMs > s.lastAtMs - s.startedAtMs) return false;
  if (a.gapCount > a.unknownDurationMs || (a.gapCount === 0 && a.unknownDurationMs !== 0)) return false;
  if (a.lastMode === null && (a.totalDistanceMm !== 0 || a.totalDurationMs !== 0)) return false;
  const distance = a.distanceSteps * t.distanceStepMeters * 1000 + a.distanceRemainderMm;
  const time = a.timeSteps * t.timeStepSeconds * 1000 + a.timeRemainderMs;
  if (!nonNeg(distance) || !nonNeg(time) || distance > a.distanceModeMm || time > a.slowDurationMs) return false;
  if (p.carryPartialSteps && (distance !== a.distanceModeMm || time !== a.slowDurationMs)) return false;
  // Do not carry unexpected nested data (including location fields) into future snapshots.
  if (Object.keys(a).some((key) => ![...fields, "lastMode"].includes(key as keyof Accumulator))) return false;
  if (Object.keys(p).some((key) => !["carryPartialSteps", "atCrossover", "minFareDisplayMs"].includes(key))) return false;
  if (!Array.isArray(s.extras)) return false;
  const ids = new Set<string>();
  let extraTotal = 0;
  for (const e of s.extras) {
    if (typeof e !== "object" || e === null || typeof e.id !== "string" || !e.id.trim() || typeof e.label !== "string" || !int(e.amountKurus) || e.amountKurus <= 0 || ids.has(e.id)) return false;
    extraTotal += e.amountKurus;
    if (!nonNeg(extraTotal) || extraTotal > 10_000_000) return false; // engine extra-charge limit
    ids.add(e.id);
  }
  return true;
}

/** Minimal storage surface (sessionStorage in the app). */
export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/**
 * Throttled saver: writes on every status change, otherwise at most every `everyMs`.
 * Storage errors (quota, blocked) are swallowed: recovery is best effort and must never
 * break metering. SERBEST removes the saved journey.
 */
export function createSaver(storage: KeyValueStore, monoNow: () => number, epochNow: () => number, everyMs = 5_000) {
  let lastAt = -Infinity;
  let lastStatus: MeterState["status"] | null = null;
  return function save(state: MeterState, force = false): void {
    const now = monoNow();
    if (!force && state.status === lastStatus && now - lastAt < everyMs) return;
    lastStatus = state.status;
    lastAt = now;
    try {
      const json = serialize(state, now, epochNow());
      if (json === null) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, json);
    } catch {
      /* quota exceeded or storage blocked */
    }
  };
}
