import type { TraceSpec } from "./trace.ts";

const still = (s: number) => ({ seconds: s, kmh: 0 });
/** Synthetic scenarios. Noise levels are assumptions loosely based on published smartphone GNSS behaviour. */
export const SCENARIOS: TraceSpec[] = [
  { name: "stationary 5 min, σ4 m", seed: 1, legs: [still(300)], noiseSigmaM: 4, accuracyM: 10 },
  { name: "stationary 10 min, σ6 m", seed: 2, legs: [still(600)], noiseSigmaM: 6, accuracyM: 12 },
  { name: "stationary 30 min, σ4 m", seed: 3, legs: [still(1800)], noiseSigmaM: 4, accuracyM: 10 },
  { name: "stationary, white noise σ5 (corr 0)", seed: 4, legs: [still(600)], noiseSigmaM: 5, noiseCorr: 0, accuracyM: 10, driftBudgetM: 1500 },
  { name: "stationary, accuracy degrading 5→45 m", seed: 5, legs: [still(600)], noiseSigmaM: 3, accuracyM: (t) => 5 + (40 * t) / 600 },
  { name: "stationary, spikes 80 m + alt. accuracy", seed: 6, legs: [still(600)], noiseSigmaM: 4, accuracyM: (t) => (t % 2 ? 8 : 30), spikes: { p: 0.03, meters: 80, accuracyM: 15 } },
  { name: "stationary, phantom Doppler 2.5 m/s (20%)", seed: 7, legs: [still(600)], noiseSigmaM: 4, accuracyM: 10, speedAvailable: true, phantomSpeed: { p: 0.2, mps: 2.5 } },
  { name: "creep 3 km/h, 10 min", seed: 8, legs: [{ seconds: 600, kmh: 3 }], noiseSigmaM: 3, accuracyM: 8 },
  { name: "slow 5–10 km/h", seed: 9, legs: Array.from({ length: 10 }, (_, i) => ({ seconds: 60, kmh: i % 2 ? 10 : 5 })), noiseSigmaM: 3, accuracyM: 8 },
  { name: "around crossover 11↔14 km/h", seed: 10, legs: Array.from({ length: 20 }, (_, i) => ({ seconds: 30, kmh: i % 2 ? 14 : 11 })), noiseSigmaM: 3, accuracyM: 8, speedAvailable: true },
  { name: "stop-and-go 0/25 km/h", seed: 11, legs: Array.from({ length: 20 }, (_, i) => ({ seconds: 30, kmh: i % 2 ? 0 : 25 })), noiseSigmaM: 3, accuracyM: 8, speedAvailable: true },
  { name: "short hops 5 s @15, 25 s stop", seed: 12, legs: Array.from({ length: 30 }, (_, i) => ({ seconds: i % 2 ? 25 : 5, kmh: i % 2 ? 0 : 15 })), noiseSigmaM: 3, accuracyM: 8 },
  { name: "straight 50 km/h, 5 min", seed: 13, legs: [{ seconds: 300, kmh: 50 }], noiseSigmaM: 3, accuracyM: 6, speedAvailable: true },
  { name: "curved road 30 km/h", seed: 14, legs: [{ seconds: 300, kmh: 30, turnDegPerS: 6 }], noiseSigmaM: 3, accuracyM: 8 },
  { name: "urban canyon: σ8, 20% drops, jitter", seed: 15, legs: [{ seconds: 120, kmh: 30 }, still(60), { seconds: 180, kmh: 20, turnDegPerS: 2 }], noiseSigmaM: 8, accuracyM: 20, dropProb: 0.2, intervalJitterMs: 400 },
  { name: "mixed 20 min + 90 s tunnel", seed: 16, legs: [{ seconds: 300, kmh: 45 }, still(120), { seconds: 300, kmh: 20 }, { seconds: 240, kmh: 60 }, still(240)], noiseSigmaM: 4, accuracyM: 10, outages: [[700, 790]], speedAvailable: true },
  { name: "mixed 20 min, no Doppler speed", seed: 17, legs: [{ seconds: 300, kmh: 45 }, still(120), { seconds: 300, kmh: 20 }, { seconds: 240, kmh: 60 }, still(240)], noiseSigmaM: 4, accuracyM: 10 },
  { name: "highway 90 km/h with braking", seed: 18, legs: [{ seconds: 240, kmh: 90 }, { seconds: 20, kmh: 20 }, { seconds: 240, kmh: 90 }], noiseSigmaM: 3, accuracyM: 6, speedAvailable: true, maxAccelMps2: 3 },
  { name: "frequent inaccurate fixes (40% > 35 m)", seed: 19, legs: [{ seconds: 300, kmh: 30 }, still(120)], noiseSigmaM: 5, accuracyM: (t) => ((t * 7919) % 10 < 4 ? 50 : 12) },
];
