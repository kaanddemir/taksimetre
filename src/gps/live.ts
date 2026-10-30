import type { Clock } from "../ui/clock.ts";
import type { MeterStore } from "../ui/store.ts";
import { DEFAULT_GPS_CONFIG, GpsProcessor, type GpsConfig, type RawFix } from "./processor.ts";
import { GpsStats } from "./stats.ts";
import { GpsTracker, type GeoApi, type GeoErrorKind } from "./tracker.ts";
import { WakeLockManager, type WakeLockApi } from "./wake-lock.ts";

/**
 * Tracking phase shown to the user. It never contradicts the meter: the meter state lives in the
 * engine, and this only describes the location feed.
 */
export type GpsPhase =
  | "off"
  | "acquiring" // waiting for a usable first fix before starting/resuming the meter
  | "live"
  | "weak" // watcher running, no usable fix for a few seconds
  | "interrupted" // watcher running, waiting for a fresh baseline after a gap / hidden page
  | "stopped" // journey active but no watcher (after reload, or permission revoked): needs a tap
  | "denied"
  | "unavailable"
  | "timeout"
  | "unsupported";

export interface LiveDeps {
  store: MeterStore;
  clock: Clock;
  geo: GeoApi | null;
  wakeLock?: WakeLockApi | null;
  isHidden?: () => boolean;
  /** Registers a visibility listener; returns an unsubscribe function. */
  onVisibilityChange?: (fn: () => void) => () => void;
  /** Resolves true if geolocation permission is already granted (no prompt). */
  permissionGranted?: () => Promise<boolean>;
  wallNow?: () => number;
  config?: GpsConfig;
  acquireTimeoutMs?: number;
}

const ACQUIRE_TIMEOUT_MS = 30_000;
const WEAK_AFTER_MS = 5_000;
const TICK_MS = 1_000;

/**
 * Connects the location feed to the meter. Fares are only ever changed through MeterStore
 * (and so through the engine): start/resume after a usable fix, measure for each processed fix,
 * gap for unknown intervals.
 */
export class LiveJourney {
  private readonly processor: GpsProcessor;
  private readonly tracker: GpsTracker | null;
  private readonly wake: WakeLockManager;
  private intent: "start" | "resume" | null = null;
  private acquireTimer: ReturnType<typeof setTimeout> | null = null;
  private suspended = false; // a previously authorized active watcher paused while hidden
  private tick: ReturnType<typeof setInterval> | null = null;
  private readonly cfg: GpsConfig;
  private readonly isHidden: () => boolean;
  /** Aggregate quality counters for the current journey (no coordinates). */
  readonly stats = new GpsStats();

  constructor(private readonly d: LiveDeps) {
    this.cfg = d.config ?? DEFAULT_GPS_CONFIG;
    this.processor = new GpsProcessor(this.cfg);
    this.isHidden = d.isHidden ?? (() => false);
    this.tracker = d.geo ? new GpsTracker(d.geo, d.clock, (f) => this.onFix(f), (e) => this.onError(e), d.wallNow) : null;
    this.wake = new WakeLockManager(d.wakeLock ?? null, this.isHidden);
    d.onVisibilityChange?.(() => this.onVisibility());
    d.store.subscribe((s) => {
      if (s.meter.status !== "MESGUL" && !this.intent && (this.tracker?.running || this.tick || this.suspended)) this.stopTracking("off");
    });
    if (!d.geo) d.store.setGps("unsupported");
  }

  get supported(): boolean {
    return this.tracker !== null;
  }
  get watching(): boolean {
    return this.tracker?.running ?? false;
  }

  /** BAŞLAT: acquire a usable fix first; the meter starts only then. */
  start(): void {
    const s = this.d.store.get();
    if (s.meter.status !== "SERBEST" || this.intent) return;
    if (!this.tracker) return this.d.store.setGps("unsupported");
    if (!this.d.store.tariffFor(s.category)) {
      this.d.store.start(); // lets the store report NO_TARIFF
      return;
    }
    this.processor.reset();
    this.stats.reset();
    this.beginAcquire("start");
  }

  /** DEVAM: reacquire before the meter resumes, so finalized time is never charged. */
  resume(): void {
    if (this.d.store.get().meter.status !== "UCRET" || this.intent || !this.tracker) return;
    this.processor.markInterrupted();
    this.beginAcquire("resume");
  }

  /** İPTAL during acquisition: nothing was started, nothing is charged. */
  cancel(): void {
    if (!this.intent) return;
    this.stopTracking("off");
  }

  /** GPS key during an active journey whose watcher is not running (after reload / denial). */
  reconnect(): void {
    if (this.d.store.get().meter.status !== "MESGUL" || !this.tracker || this.tracker.running) return;
    this.processor.markInterrupted();
    this.d.store.setGps("interrupted");
    if (this.isHidden()) { this.suspended = true; void this.wake.enable(); return; }
    this.tracker.start();
    this.startTick();
    void this.wake.enable();
  }

  /** Called after a journey was restored from storage. Reconnects silently only if permission is already granted. */
  async afterRestore(): Promise<void> {
    if (this.d.store.get().meter.status !== "MESGUL") return;
    this.processor.markInterrupted();
    this.d.store.setGps("stopped");
    if (this.tracker && this.d.permissionGranted && (await this.d.permissionGranted().catch(() => false))) this.reconnect();
  }

  private beginAcquire(intent: "start" | "resume"): void {
    if (this.isHidden()) return;
    this.suspended = false;
    this.intent = intent;
    this.d.store.setGps("acquiring");
    this.tracker!.start();
    this.acquireTimer = setTimeout(() => this.abortAcquire("timeout"), this.d.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS);
  }

  private abortAcquire(phase: GpsPhase): void {
    this.stopTracking(phase);
  }

  private onFix(fix: RawFix): void {
    if (this.isHidden()) return; // fixes delivered while hidden are not trusted
    const r = this.processor.process(fix);
    this.stats.record(fix, r);
    const store = this.d.store;

    if (this.intent) {
      if (r.kind !== "baseline") return; // keep waiting for a usable fix
      const intent = this.intent;
      this.clearAcquire();
      const ok = intent === "start" ? store.start(r.atMs) : store.resume(r.atMs);
      if (!ok) return this.stopTracking("off");
      store.setGps("live");
      this.startTick();
      void this.wake.enable();
      return;
    }

    if (store.get().meter.status !== "MESGUL") return;
    if (r.kind === "baseline") {
      store.gap(r.atMs); // unknown interval since the last confirmed measurement: recorded, not charged
      store.setGps("live");
    } else if (r.kind === "measure") {
      store.measure(r.measurement);
      store.setGps("live");
    }
  }

  private onError(e: GeoErrorKind): void {
    if (this.intent) {
      if (e === "denied" || e === "unavailable") this.abortAcquire(e);
      return; // timeouts while acquiring: keep waiting until our own deadline
    }
    if (e === "denied" && this.d.store.get().meter.status === "MESGUL") {
      this.processor.markInterrupted();
      this.tracker?.stop();
      this.stopTick();
      void this.wake.disable();
      this.d.store.setGps("denied");
    }
    // unavailable / timeout mid-journey are usually transient; the tick shows weak/interrupted.
  }

  private onTick(): void {
    const store = this.d.store;
    if (store.get().meter.status !== "MESGUL" || !this.tracker?.running || this.isHidden()) return;
    const last = this.processor.lastUsableAtMs;
    const age = last === null ? Infinity : this.d.clock.now() - last;
    if (age > WEAK_AFTER_MS) this.tracker.probe();
    const phase = store.get().gps;
    if (last === null || age > this.cfg.maxIntervalMs) {
      if (phase !== "interrupted") store.setGps("interrupted");
    } else if (age > WEAK_AFTER_MS && phase === "live") store.setGps("weak");
  }

  private onVisibility(): void {
    const status = this.d.store.get().meter.status;
    if (this.isHidden()) {
      // Acquisition has not started/resumed a journey: cancel rather than
      // leaving a permission request or location watcher alive in the background.
      if (this.intent) { this.stopTracking("off"); return; }
      if (status === "MESGUL" && this.tracker?.running) {
        this.suspended = true;
        this.tracker.stop(); // invalidates pending watch and probe callbacks
        this.stopTick();
        this.processor.markInterrupted();
        this.d.store.setGps("interrupted");
      }
      return;
    }
    if (this.suspended) {
      this.suspended = false;
      if (status === "MESGUL" && this.tracker) {
        this.tracker.start();
        this.startTick();
        void this.wake.onVisible();
      }
    }
  }

  private startTick(): void {
    if (this.tick === null) this.tick = setInterval(() => this.onTick(), TICK_MS);
  }
  private stopTick(): void {
    if (this.tick !== null) clearInterval(this.tick);
    this.tick = null;
  }
  private clearAcquire(): void {
    if (this.acquireTimer !== null) clearTimeout(this.acquireTimer);
    this.acquireTimer = null;
    this.intent = null;
  }

  private stopTracking(phase: GpsPhase): void {
    this.suspended = false;
    this.clearAcquire();
    this.tracker?.stop();
    this.stopTick();
    void this.wake.disable();
    this.processor.reset();
    this.d.store.setGps(phase);
  }
}
