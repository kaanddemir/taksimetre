import type { Clock } from "../ui/clock.ts";
import type { RawFix } from "./processor.ts";

/** Subset of the Geolocation API used here (injectable for tests). */
export interface GeoApi {
  watchPosition(ok: PositionCallback, err: PositionErrorCallback, opts?: PositionOptions): number;
  clearWatch(id: number): void;
  getCurrentPosition(ok: PositionCallback, err: PositionErrorCallback, opts?: PositionOptions): void;
}

export type GeoErrorKind = "denied" | "unavailable" | "timeout";

const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 };
const PROBE_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 8_000 };

/**
 * Owns at most one geolocation watcher. `probe()` asks for one extra fix when the watcher has gone
 * quiet: some browsers only call watchPosition back when the position changes, which would make a
 * parked taxi look like a signal gap.
 */
export class GpsTracker {
  private watchId: number | null = null;
  private probing = false;
  /** Incremented per start/stop so callbacks from an older session are dropped. */
  private generation = 0;

  constructor(
    private readonly geo: GeoApi,
    private readonly clock: Clock,
    private readonly onFix: (f: RawFix) => void,
    private readonly onError: (e: GeoErrorKind) => void,
    private readonly wallNow: () => number = Date.now,
  ) {}

  get running(): boolean {
    return this.watchId !== null;
  }

  start(): void {
    if (this.watchId !== null) return; // never two watchers
    const gen = ++this.generation;
    this.watchId = this.geo.watchPosition((p) => this.handle(p, gen), (e) => this.fail(e, gen), WATCH_OPTIONS);
  }

  stop(): void {
    if (this.watchId !== null) this.geo.clearWatch(this.watchId);
    this.watchId = null;
    this.probing = false;
    this.generation++;
  }

  probe(): void {
    if (this.watchId === null || this.probing) return;
    this.probing = true;
    const gen = this.generation;
    this.geo.getCurrentPosition(
      (p) => { if (gen === this.generation) this.probing = false; this.handle(p, gen); },
      (e) => { if (gen === this.generation) this.probing = false; this.fail(e, gen); },
      PROBE_OPTIONS,
    );
  }

  private handle(p: GeolocationPosition, gen: number): void {
    if (this.watchId === null || gen !== this.generation) return; // late callback from a stopped session
    const c = p.coords;
    this.onFix({
      lat: c.latitude,
      lon: c.longitude,
      accuracyM: c.accuracy,
      speedMps: typeof c.speed === "number" ? c.speed : null,
      timestampMs: p.timestamp,
      receivedAtMs: this.clock.now(),
      wallNowMs: this.wallNow(),
    });
  }

  private fail(e: GeolocationPositionError, gen: number): void {
    if (this.watchId === null || gen !== this.generation) return;
    this.onError(e.code === 1 ? "denied" : e.code === 3 ? "timeout" : "unavailable");
  }
}
