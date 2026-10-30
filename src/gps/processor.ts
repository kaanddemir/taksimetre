import type { Measurement } from "../engine/measurement.ts";
import { haversineM } from "./geo.ts";

/** A browser position reading plus the two clocks it was received on. */
export interface RawFix {
  lat: number;
  lon: number;
  accuracyM: number;
  /** coords.speed in m/s, or null when the browser does not provide it. */
  speedMps: number | null;
  /** position.timestamp (epoch ms, from the location provider). Orders fixes and times movement. */
  timestampMs: number;
  /** Monotonic app clock when the callback ran. This is the engine's time base. */
  receivedAtMs: number;
  /** Date.now() when the callback ran; used only to detect stale cached fixes. */
  wallNowMs: number;
}

/**
 * Provisional thresholds, not validated constants. They need field tuning on real devices.
 * Reasoning for each is in docs/TECHNICAL.md §4.
 */
export interface GpsConfig {
  maxAccuracyM: number; // fixes less accurate than this are ignored
  maxSpeedKmh: number; // displacement implying more than this is a jump, not movement
  maxIntervalMs: number; // longer than this between usable fixes = unknown interval (not charged)
  maxFixAgeMs: number; // fixes older than this (cached) are ignored
  minMoveM: number; // movement threshold floor
  moveAccuracyFactor: number; // threshold = factor × (anchor accuracy + fix accuracy) …
  maxMoveThresholdM: number; // … capped here
  deviceMovingMps: number; // Doppler speed at or above this counts as real movement
  speedTauMs: number; // speed smoothing time constant
  speedWindowMs: number; // displacement window for coordinate-derived speed
  minMovingKmh: number; // estimated speed below this never credits distance (drift guard)
}

export const DEFAULT_GPS_CONFIG: Readonly<GpsConfig> = Object.freeze({
  maxAccuracyM: 35,
  maxSpeedKmh: 200,
  maxIntervalMs: 15_000,
  maxFixAgeMs: 10_000,
  minMoveM: 5,
  moveAccuracyFactor: 0.5,
  maxMoveThresholdM: 30,
  deviceMovingMps: 2,
  speedTauMs: 2_000,
  speedWindowMs: 5_000,
  minMovingKmh: 8,
});

export type RejectReason = "invalid" | "stale" | "duplicate" | "inaccurate" | "jump";

export type ProcessResult =
  /** First usable fix after a reset; `afterGap` when the previous usable fix was too long ago. */
  | { kind: "baseline"; atMs: number; afterGap: boolean }
  | { kind: "measure"; measurement: Measurement }
  | { kind: "rejected"; reason: RejectReason };

interface Anchor {
  lat: number;
  lon: number;
  accuracyM: number;
  timestampMs: number;
}

/**
 * Turns raw fixes into the engine's normalized measurements.
 *
 * Distance: an "anchor" position is held until displacement exceeds a noise threshold derived from
 * the reported accuracy of both points (two noisy fixes can be up to ~2× the noise apart), then the whole anchor→fix distance is credited and the anchor moves. Jitter
 * around a parked car therefore never accumulates, while slow real movement is credited in full once
 * it clears the threshold, so it is not undercounted.
 *
 * Speed: Doppler coords.speed when the browser gives a plausible value, otherwise displacement from the
 * anchor over GPS time, smoothed with a short exponential filter.
 */
export class GpsProcessor {
  private anchor: Anchor | null = null;
  private lastTimestampMs: number | null = null;
  private lastReceivedAtMs: number | null = null;
  private speedKmh: number | null = null;
  private needsBaseline = true;
  /** Recent accepted fixes (bounded by speedWindowMs) for jump checks and windowed speed. */
  private recent: Anchor[] = [];

  constructor(private readonly cfg: GpsConfig = DEFAULT_GPS_CONFIG) {}

  /** Forget everything (new journey). */
  reset(): void {
    this.anchor = null;
    this.lastTimestampMs = null;
    this.lastReceivedAtMs = null;
    this.speedKmh = null;
    this.needsBaseline = true;
    this.recent = [];
  }

  /** Tracking became untrustworthy (hidden page, restore, denied): the next usable fix starts fresh. */
  markInterrupted(): void {
    this.needsBaseline = true;
    this.anchor = null;
    this.speedKmh = null;
    this.recent = [];
  }

  /** Monotonic time of the last usable fix, or null. */
  get lastUsableAtMs(): number | null {
    return this.needsBaseline ? null : this.lastReceivedAtMs;
  }

  process(fix: RawFix): ProcessResult {
    if (!validFix(fix)) return { kind: "rejected", reason: "invalid" };
    if (fix.wallNowMs - fix.timestampMs > this.cfg.maxFixAgeMs) return { kind: "rejected", reason: "stale" };
    if (this.lastTimestampMs !== null && fix.timestampMs <= this.lastTimestampMs) return { kind: "rejected", reason: "duplicate" };
    if (this.lastReceivedAtMs !== null && fix.receivedAtMs < this.lastReceivedAtMs) return { kind: "rejected", reason: "duplicate" };
    if (fix.accuracyM > this.cfg.maxAccuracyM) return { kind: "rejected", reason: "inaccurate" };

    const gap = this.lastReceivedAtMs !== null && fix.receivedAtMs - this.lastReceivedAtMs > this.cfg.maxIntervalMs;
    if (this.needsBaseline || this.anchor === null || gap) {
      const afterGap = !this.needsBaseline && gap;
      this.needsBaseline = false;
      this.anchor = anchorOf(fix);
      this.speedKmh = null;
      this.recent = [];
      this.accept(fix);
      return { kind: "baseline", atMs: fix.receivedAtMs, afterGap };
    }

    const a = this.anchor;
    const last = this.recent[this.recent.length - 1]!;
    // Jump check against the last accepted fix (not the anchor, which may be minutes old when parked).
    const dLast = haversineM(last.lat, last.lon, fix.lat, fix.lon);
    const dtLastS = (fix.timestampMs - last.timestampMs) / 1000;
    if ((dLast / dtLastS) * 3.6 > this.cfg.maxSpeedKmh) return { kind: "rejected", reason: "jump" };

    // Coordinate-derived speed over a short window (oldest accepted fix within speedWindowMs).
    const ref = this.recent.find((r) => fix.timestampMs - r.timestampMs <= this.cfg.speedWindowMs) ?? last;
    const dtRefS = (fix.timestampMs - ref.timestampMs) / 1000;
    const windowKmh = (haversineM(ref.lat, ref.lon, fix.lat, fix.lon) / dtRefS) * 3.6;

    const device = plausibleDeviceSpeed(fix.speedMps, this.cfg.maxSpeedKmh);
    const rawKmh = device !== null ? device * 3.6 : windowKmh;
    const dtMs = fix.receivedAtMs - this.lastReceivedAtMs!;
    const alpha = 1 - Math.exp(-dtMs / this.cfg.speedTauMs);
    this.speedKmh = this.speedKmh === null ? rawKmh : this.speedKmh + alpha * (rawKmh - this.speedKmh);

    const d = haversineM(a.lat, a.lon, fix.lat, fix.lon);
    const threshold = Math.min(this.cfg.maxMoveThresholdM, Math.max(this.cfg.minMoveM, this.cfg.moveAccuracyFactor * (a.accuracyM + fix.accuracyM)));
    // Displacement must clear the noise threshold AND be corroborated by the speed estimate;
    // the Doppler shortcut additionally requires the window displacement to agree (no phantom speed).
    const viaThreshold = d >= threshold && this.speedKmh >= this.cfg.minMovingKmh;
    const viaDoppler = device !== null && device >= this.cfg.deviceMovingMps && d >= this.cfg.minMoveM && windowKmh >= device * 3.6 * 0.5;
    const moved = viaThreshold || viaDoppler;
    if (moved) this.anchor = anchorOf(fix);
    this.accept(fix);

    return {
      kind: "measure",
      measurement: {
        atMs: fix.receivedAtMs,
        distanceMm: moved ? Math.round(d * 1000) : 0,
        speedKmh: Math.min(300, Math.round(this.speedKmh * 100) / 100),
      },
    };
  }

  private accept(fix: RawFix): void {
    this.lastTimestampMs = fix.timestampMs;
    this.lastReceivedAtMs = fix.receivedAtMs;
    this.recent.push(anchorOf(fix));
    while (this.recent.length > 1 && fix.timestampMs - this.recent[0]!.timestampMs > this.cfg.speedWindowMs) this.recent.shift();
  }
}

function anchorOf(f: RawFix): Anchor {
  return { lat: f.lat, lon: f.lon, accuracyM: f.accuracyM, timestampMs: f.timestampMs };
}

function validFix(f: RawFix): boolean {
  return (
    Number.isFinite(f.lat) && Math.abs(f.lat) <= 90 &&
    Number.isFinite(f.lon) && Math.abs(f.lon) <= 180 &&
    Number.isFinite(f.accuracyM) && f.accuracyM > 0 &&
    Number.isFinite(f.timestampMs) && Number.isSafeInteger(f.receivedAtMs) && Number.isFinite(f.wallNowMs) &&
    (f.speedMps === null || typeof f.speedMps === "number")
  );
}

/** coords.speed is optional and sometimes NaN or negative; only plausible values are used. */
function plausibleDeviceSpeed(v: number | null, maxKmh: number): number | null {
  if (v === null || !Number.isFinite(v) || v < 0 || v * 3.6 > maxKmh) return null;
  return v;
}
