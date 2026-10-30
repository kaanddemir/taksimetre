import type { RawFix } from "../src/gps/processor.ts";
import type { GeoApi } from "../src/gps/tracker.ts";

export const LAT0 = 41.0369; // Taksim
export const LON0 = 28.985;
export const M_PER_DEG_LAT = (6_371_008.8 * Math.PI) / 180;
export const EPOCH0 = Date.UTC(2026, 9, 30, 9, 0, 0);

/** A fix `north` metres north of the origin at monotonic time `t` (GPS clock in sync). */
export function fix(t: number, north: number, opts: Partial<RawFix> = {}): RawFix {
  return {
    lat: LAT0 + north / M_PER_DEG_LAT,
    lon: LON0,
    accuracyM: 8,
    speedMps: null,
    timestampMs: EPOCH0 + t,
    receivedAtMs: t,
    wallNowMs: EPOCH0 + t,
    ...opts,
  };
}

/** Deterministic pseudo-random in [-1, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;
}

/** Controllable Geolocation API. */
export class FakeGeo implements GeoApi {
  watches = new Map<number, { ok: PositionCallback; err: PositionErrorCallback }>();
  probes: { ok: PositionCallback; err: PositionErrorCallback }[] = [];
  private next = 1;
  watchPosition(ok: PositionCallback, err: PositionErrorCallback): number {
    const id = this.next++;
    this.watches.set(id, { ok, err });
    return id;
  }
  clearWatch(id: number): void {
    this.watches.delete(id);
  }
  getCurrentPosition(ok: PositionCallback, err: PositionErrorCallback): void {
    this.probes.push({ ok, err });
  }
  /** Delivers a position (epoch timestamp) to every watcher. */
  emit(epochTs: number, north: number, accuracy = 8, speed: number | null = null): void {
    const p = {
      timestamp: epochTs,
      coords: { latitude: LAT0 + north / M_PER_DEG_LAT, longitude: LON0, accuracy, speed, altitude: null, altitudeAccuracy: null, heading: null },
    } as unknown as GeolocationPosition;
    for (const w of [...this.watches.values()]) w.ok(p);
  }
  error(code: 1 | 2 | 3): void {
    const e = { code, message: "x", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError;
    for (const w of [...this.watches.values()]) w.err(e);
  }
}
