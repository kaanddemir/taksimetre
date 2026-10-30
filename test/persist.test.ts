import { describe, expect, it } from "vitest";
import { readMeter } from "../src/engine/fare.ts";
import { IDLE, transition, type MeterCommand, type MeterState } from "../src/engine/meter.ts";
import { createSaver, restore, serialize, STORAGE_KEY } from "../src/journey/persist.ts";
import { ISTANBUL_TARIFFS } from "../src/tariff/istanbul.ts";
import { ManualClock } from "../src/ui/clock.ts";
import { MeterStore } from "../src/ui/store.ts";
import { YELLOW } from "./helpers.ts";

const EPOCH = Date.UTC(2026, 9, 30, 9);
function run(...cmds: MeterCommand[]): MeterState {
  let s: MeterState = IDLE;
  for (const c of cmds) {
    const r = transition(s, c);
    if (!r.ok) throw new Error(r.error);
    s = r.state;
  }
  return s;
}
const active = () => run(
  { type: "start", tariff: YELLOW, atMs: 1_000 },
  { type: "measure", measurement: { atMs: 61_000, distanceMm: 1_000_000, speedKmh: 60 } },
  { type: "measure", measurement: { atMs: 121_000, distanceMm: 0, speedKmh: 0 } },
);

describe("journey persistence", () => {
  it("SERBEST is not stored", () => {
    expect(serialize(IDLE, 0, EPOCH)).toBeNull();
  });

  it("MESGUL round-trip: same fare, rebased clock, page downtime recorded as a gap", () => {
    const s = active();
    const json = serialize(s, 125_000, EPOCH)!; // saved 4 s after the last measurement
    expect(json).not.toMatch(/lat|lon/);
    const r = restore(json, ISTANBUL_TARIFFS, 300, EPOCH + 30_000); // reloaded 30 s later, new page clock
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unknownMs).toBe(34_000);
    const store = new MeterStore(new ManualClock(300), ISTANBUL_TARIFFS, () => "2026-10-30");
    store.restore(r.meter);
    expect(store.gap(300)).toBe(true);
    const m = readMeter(store.get().meter);
    expect(m.meterFareKurus).toBe(readMeter(s).meterFareKurus);
    expect(m).toMatchObject({ gapCount: 1, unknownDurationMs: 34_000, totalDistanceMm: 1_000_000 });
    expect(store.measure({ atMs: 60_300, distanceMm: 0, speedKmh: 0 })).toBe(true); // continues normally
  });

  it("UCRET round-trip keeps the payable amount and display countdown", () => {
    const s = transition(active(), { type: "finalize", atMs: 121_000 }).state;
    const r = restore(serialize(s, 125_000, EPOCH), ISTANBUL_TARIFFS, 500, EPOCH + 2_000);
    expect(r.ok && r.meter.status).toBe("UCRET");
    if (!r.ok || r.meter.status !== "UCRET") return;
    expect(500 - r.meter.finalizedAtMs).toBe(6_000); // 4 s before save + 2 s downtime
    expect(r.unknownMs).toBe(0);
  });

  it("rejects corrupt, incompatible, unknown-tariff and expired data", () => {
    const json = serialize(active(), 125_000, EPOCH)!;
    const mod = (f: (o: any) => void) => { const o = JSON.parse(json); f(o); return JSON.stringify(o); };
    const r = (j: string | null, now = EPOCH + 1_000) => restore(j, ISTANBUL_TARIFFS, 0, now);
    expect(r(null)).toEqual({ ok: false, reason: "empty" });
    expect(r("{nope")).toEqual({ ok: false, reason: "corrupt" });
    expect(r("null")).toEqual({ ok: false, reason: "corrupt" });
    expect(r(mod((o) => (o.v = 0)))).toEqual({ ok: false, reason: "version" });
    expect(r(mod((o) => (o.tariffId = "ist-unknown")))).toEqual({ ok: false, reason: "tariff" });
    expect(r(mod((o) => (o.acc.distanceSteps = -1)))).toEqual({ ok: false, reason: "corrupt" });
    expect(r(mod((o) => (o.acc.distanceRemainderMm = 100_000)))).toEqual({ ok: false, reason: "corrupt" });
    expect(r(mod((o) => (o.acc.timeSteps = 1.5)))).toEqual({ ok: false, reason: "corrupt" });
    expect(r(mod((o) => (o.status = "SERBEST")))).toEqual({ ok: false, reason: "corrupt" });
    expect(r(mod((o) => (o.lastAtMs = 0)))).toEqual({ ok: false, reason: "corrupt" });
    expect(r(mod((o) => (o.extras = [{ id: "a", label: "a", amountKurus: 5 }, { id: "a", label: "b", amountKurus: 5 }])))).toEqual({ ok: false, reason: "corrupt" });
    expect(r(mod((o) => (o.policy.atCrossover = "x")))).toEqual({ ok: false, reason: "corrupt" });
    expect(r(json, EPOCH + 13 * 3_600_000)).toEqual({ ok: false, reason: "expired" });
    expect(r(json, EPOCH - 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("restored journey uses the registry tariff, not stored values", () => {
    const r = restore(serialize(active(), 125_000, EPOCH), ISTANBUL_TARIFFS, 0, EPOCH);
    expect(r.ok && r.meter.status !== "SERBEST" && r.meter.journey.tariff).toBe(YELLOW);
  });

  it("store refuses to restore over an existing journey", () => {
    const store = new MeterStore(new ManualClock(0), ISTANBUL_TARIFFS, () => "2026-10-30");
    store.start();
    expect(store.restore(active())).toBe(false);
  });
});

describe("saver", () => {
  function mem() {
    const m = new Map<string, string>();
    let writes = 0;
    let failing = false;
    return {
      m, get writes() { return writes; }, fail(f: boolean) { failing = f; },
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { if (failing) throw new DOMException("quota", "QuotaExceededError"); writes++; m.set(k, v); },
      removeItem: (k: string) => void m.delete(k),
    };
  }
  it("throttles writes while running, writes immediately on status change, removes on SERBEST", () => {
    const st = mem();
    let now = 125_000;
    const save = createSaver(st, () => now, () => EPOCH + now);
    const s = active();
    save(s);
    now += 1_000; save(s);
    now += 1_000; save(s);
    expect(st.writes).toBe(1);
    now += 5_000; save(s);
    expect(st.writes).toBe(2);
    const fin = transition(s, { type: "finalize", atMs: 121_000 }).state;
    save(fin);
    expect(st.writes).toBe(3);
    save(IDLE);
    expect(st.m.has(STORAGE_KEY)).toBe(false);
  });
  it("storage errors never throw", () => {
    const st = mem();
    st.fail(true);
    const save = createSaver(st, () => 125_000, () => EPOCH);
    expect(() => save(active(), true)).not.toThrow();
  });
  it("missing fields or wrong types are rejected", () => {
    const json = serialize(active(), 125_000, EPOCH)!;
    for (const mut of [(o: any) => delete o.acc.gapCount, (o: any) => (o.savedAtEpochMs = String(o.savedAtEpochMs)), (o: any) => delete o.policy, (o: any) => (o.extras = {}), (o: any) => (o.acc.lastMode = "fly")]) {
      const o = JSON.parse(json); mut(o);
      expect(restore(JSON.stringify(o), ISTANBUL_TARIFFS, 0, EPOCH + 1).ok).toBe(false);
    }
  });
});

describe("storage consistency boundaries", () => {
  it("rejects inconsistent counters, unsafe arithmetic, unexpected nested data and excessive extras", () => {
    const json = serialize(active(), 125_000, EPOCH)!;
    const mutations: ((o: any) => void)[] = [
      (o) => o.acc.distanceSteps++, (o) => o.acc.timeSteps++,
      (o) => o.acc.totalDistanceMm = 5_000_000_001,
      (o) => o.acc.totalDurationMs = 48 * 3_600_000 + 1,
      (o) => o.acc.unknownDurationMs = 1,
      (o) => o.acc.gapCount = 1,
      (o) => o.acc.lastMode = null,
      (o) => o.acc.distanceSteps = Number.MAX_SAFE_INTEGER,
      (o) => o.startedAtMs = -Number.MAX_SAFE_INTEGER,
      (o) => o.savedAtMonoMs = -1,
      (o) => o.finalizedAtMs = 123,
      (o) => o.acc.lat = 41.0369,
      (o) => o.policy.extra = {},
      (o) => o.extras = [{ id: "toll", label: "Toll", amountKurus: 10_000_001 }],
      (o) => o.extras = [{ id: " ", label: "Toll", amountKurus: 1 }],
    ];
    for (const mutate of mutations) {
      const record = JSON.parse(json); mutate(record);
      expect(restore(JSON.stringify(record), ISTANBUL_TARIFFS, 100, EPOCH + 100)).toEqual({ ok: false, reason: "corrupt" });
    }
  });

  it("keeps supported non-carry policy records and journeys containing gaps and resumes valid", () => {
    const state = run(
      { type: "start", tariff: YELLOW, atMs: 1000, policy: { carryPartialSteps: false } },
      { type: "measure", measurement: { atMs: 2000, distanceMm: 50_000, speedKmh: 60 } },
      { type: "measure", measurement: { atMs: 3000, distanceMm: 0, speedKmh: 0 } },
      { type: "gap", atMs: 4000 },
      { type: "finalize", atMs: 4500 }, { type: "resume", atMs: 8000 },
      { type: "measure", measurement: { atMs: 9000, distanceMm: 50_000, speedKmh: 60 } },
    );
    const first = restore(serialize(state, 10_000, EPOCH), ISTANBUL_TARIFFS, 0, EPOCH + 1000);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(readMeter(first.meter).meterFareKurus).toBe(readMeter(state).meterFareKurus);
    expect(restore(serialize(first.meter, 0, EPOCH + 1000), ISTANBUL_TARIFFS, 10, EPOCH + 2000).ok).toBe(true);
  });
});


it("rejects recovery gaps that would exceed the engine's supported journey duration", () => {
  const state = run({ type: "start", tariff: YELLOW, atMs: 0 }, { type: "gap", atMs: 48 * 3_600_000 });
  const json = serialize(state, 48 * 3_600_000, EPOCH);
  expect(restore(json, ISTANBUL_TARIFFS, 0, EPOCH + 1)).toEqual({ ok: false, reason: "expired" });
});
