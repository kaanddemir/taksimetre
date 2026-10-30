/**
 * SYNTHETIC GPS trace generator (not real recordings). Produces ground truth (per-second
 * true motion) and a noisy fix stream with correlated (AR(1)) position error, reported
 * accuracy, optional Doppler speed, dropouts, spikes and irregular callback intervals.
 */
import type { RawFix } from "../../src/gps/processor.ts";
import type { Segment } from "../../src/engine/simulate.ts";

export interface Leg {
  seconds: number;
  kmh: number;
  turnDegPerS?: number;
}
export interface TraceSpec {
  name: string;
  legs: Leg[];
  seed: number;
  noiseSigmaM: number; // std-dev of the correlated position error
  noiseCorr?: number; // AR(1) coefficient per second (0.9 = slowly wandering error)
  accuracyM: number | ((t: number) => number);
  speedAvailable?: boolean;
  speedNoiseMps?: number;
  /** Probability per fix of a plausible-but-wrong device speed (stationary "phantom" speed). */
  phantomSpeed?: { p: number; mps: number };
  dropProb?: number; // probability a callback is missed
  intervalJitterMs?: number; // callback times uniformly ±jitter around 1 s
  spikes?: { p: number; meters: number; accuracyM: number }; // multipath outliers
  outages?: [number, number][]; // [startS, endS) with no fixes (tunnels)
  maxAccelMps2?: number;
  /** Allowed displayed drift for stationary stress cases (regression guard). Default 400 m. */
  driftBudgetM?: number;
}
export interface Trace {
  spec: TraceSpec;
  fixes: RawFix[];
  truthSegments: Segment[]; // 1 s true motion: the reference a perfect meter would see
  truthM: number;
}

const M = (6_371_008.8 * Math.PI) / 180;
const LAT0 = 41.0369;
const LON0 = 28.985;
const EPOCH = Date.UTC(2026, 9, 30, 9);

function prng(seed: number) {
  let s = seed >>> 0;
  const u = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const gauss = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, gauss };
}

export function generate(spec: TraceSpec): Trace {
  const r = prng(spec.seed);
  const corr = spec.noiseCorr ?? 0.9;
  const innov = spec.noiseSigmaM * Math.sqrt(1 - corr * corr);
  const maxAcc = spec.maxAccelMps2 ?? 2;
  let x = 0, y = 0, heading = 0, v = 0, ex = 0, ey = 0;
  let t = 0;
  const truthSegments: Segment[] = [];
  const truth: { x: number; y: number; v: number }[] = [{ x, y, v }];
  for (const leg of spec.legs) {
    const target = leg.kmh / 3.6;
    for (let i = 0; i < leg.seconds; i++) {
      const dv = Math.max(-maxAcc, Math.min(maxAcc, target - v));
      const v0 = v;
      v += dv;
      const d = (v0 + v) / 2;
      heading += ((leg.turnDegPerS ?? 0) * Math.PI) / 180;
      x += d * Math.cos(heading);
      y += d * Math.sin(heading);
      truthSegments.push({ distanceM: d, durationS: 1 });
      truth.push({ x, y, v });
      t++;
    }
  }
  const fixes: RawFix[] = [];
  const total = truth.length - 1;
  let tMs = -1;
  for (let s = 0; s <= total; s++) {
    ex = corr * ex + innov * r.gauss();
    ey = corr * ey + innov * r.gauss();
    if (s === 0) { ex = 0; ey = 0; } // first fix accurate (acquisition)
    const inOutage = spec.outages?.some(([a, b]) => s >= a && s < b);
    const dropped = s > 0 && r.u() < (spec.dropProb ?? 0);
    const jitter = spec.intervalJitterMs ? (r.u() * 2 - 1) * spec.intervalJitterMs : 0;
    tMs = Math.max(tMs + 1, Math.round(s * 1000 + (s > 0 ? jitter : 0)));
    if (inOutage || dropped) continue;
    const p = truth[s]!;
    let px = p.x + ex, py = p.y + ey;
    let acc = typeof spec.accuracyM === "function" ? spec.accuracyM(s) : spec.accuracyM;
    if (spec.spikes && s > 0 && r.u() < spec.spikes.p) {
      const a = r.u() * 2 * Math.PI;
      px += spec.spikes.meters * Math.cos(a);
      py += spec.spikes.meters * Math.sin(a);
      acc = spec.spikes.accuracyM;
    }
    let speed: number | null = null;
    if (spec.speedAvailable) speed = Math.max(0, p.v + (spec.speedNoiseMps ?? 0.3) * r.gauss());
    if (spec.phantomSpeed && p.v === 0 && r.u() < spec.phantomSpeed.p) speed = spec.phantomSpeed.mps;
    fixes.push({
      lat: LAT0 + py / M,
      lon: LON0 + px / (M * Math.cos((LAT0 * Math.PI) / 180)),
      accuracyM: acc,
      speedMps: speed,
      timestampMs: EPOCH + tMs,
      receivedAtMs: tMs + 50, // small, constant delivery delay
      wallNowMs: EPOCH + tMs + 50,
    });
  }
  return { spec, fixes, truthSegments, truthM: truthSegments.reduce((a, s) => a + s.distanceM, 0) };
}
