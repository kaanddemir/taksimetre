import { readMeter } from "../../src/engine/fare.ts";
import { IDLE, transition, type MeterCommand, type MeterState } from "../../src/engine/meter.ts";
import { simulateSegments } from "../../src/engine/simulate.ts";
import { haversineM } from "../../src/gps/geo.ts";
import { GpsProcessor, type GpsConfig, DEFAULT_GPS_CONFIG } from "../../src/gps/processor.ts";
import { ISTANBUL_TARIFFS } from "../../src/tariff/istanbul.ts";
import type { Trace } from "./trace.ts";

const TARIFF = ISTANBUL_TARIFFS[0]!;

export interface ReplayResult {
  name: string;
  truthM: number;
  rawM: number;
  appM: number;
  distErrPct: number;
  truthSlowS: number;
  appSlowS: number;
  unknownS: number;
  truthFare: number;
  appFare: number;
  fareErrPct: number;
  rejected: number;
}

/** Same path as LiveJourney: processor → start/measure/gap → engine. */
export function replay(trace: Trace, cfg: GpsConfig = DEFAULT_GPS_CONFIG): ReplayResult {
  const p = new GpsProcessor(cfg);
  let s: MeterState = IDLE;
  let rejected = 0;
  for (const f of trace.fixes) {
    const r = p.process(f);
    let cmd: MeterCommand | null = null;
    if (r.kind === "baseline") cmd = s.status === "SERBEST" ? { type: "start", tariff: TARIFF, atMs: r.atMs } : { type: "gap", atMs: r.atMs };
    else if (r.kind === "measure") cmd = { type: "measure", measurement: r.measurement };
    else rejected++;
    if (!cmd) continue;
    const res = transition(s, cmd);
    if (!res.ok) throw new Error(`${trace.spec.name}: ${res.error}`);
    s = res.state;
  }
  const app = readMeter(s);
  const truth = simulateSegments(TARIFF, trace.truthSegments);
  let rawM = 0;
  for (let i = 1; i < trace.fixes.length; i++) {
    const a = trace.fixes[i - 1]!, b = trace.fixes[i]!;
    rawM += haversineM(a.lat, a.lon, b.lat, b.lon);
  }
  const truthSlowS = trace.truthSegments.filter((g) => g.distanceM * 3.6 < 12.5).length;
  return {
    name: trace.spec.name,
    truthM: trace.truthM,
    rawM,
    appM: app.totalDistanceMm / 1000,
    distErrPct: trace.truthM > 0 ? ((app.totalDistanceMm / 1000 - trace.truthM) / trace.truthM) * 100 : NaN,
    truthSlowS,
    appSlowS: app.slowDurationMs / 1000,
    unknownS: app.unknownDurationMs / 1000,
    truthFare: truth.meterFareKurus,
    appFare: app.meterFareKurus,
    fareErrPct: ((app.meterFareKurus - truth.meterFareKurus) / truth.meterFareKurus) * 100,
    rejected,
  };
}

export function table(rows: ReplayResult[]): string {
  const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "—");
  const tl = (k: number) => (k / 100).toFixed(2);
  const lines = [
    "| Scenario (synthetic) | True m | Raw GPS m | App m | Dist err % | True slow s | App slow s | Unknown s | Ref fare | App fare | Fare err % |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.name} | ${f(r.truthM, 0)} | ${f(r.rawM, 0)} | ${f(r.appM, 0)} | ${f(r.distErrPct)} | ${r.truthSlowS} | ${f(r.appSlowS, 0)} | ${f(r.unknownS, 0)} | ${tl(r.truthFare)} | ${tl(r.appFare)} | ${f(r.fareErrPct)} |`),
  ];
  return lines.join("\n");
}
