import type { ProcessResult, RawFix } from "./processor.ts";

/**
 * Aggregate GPS quality counters for field validation (?diag). No coordinates are kept:
 * only counts and fixed-size histograms, so memory is bounded for any journey length.
 */
export class GpsStats {
  fixes = 0;
  accepted = 0;
  rejected: Record<string, number> = {};
  withSpeed = 0;
  private acc = new Uint32Array(101); // 1 m buckets, last = ≥100 m
  private interval = new Uint32Array(301); // 0.1 s buckets, last = ≥30 s
  private lastAt: number | null = null;

  record(f: RawFix, r: ProcessResult): void {
    this.fixes++;
    if (r.kind === "rejected") this.rejected[r.reason] = (this.rejected[r.reason] ?? 0) + 1;
    else this.accepted++;
    if (typeof f.speedMps === "number" && Number.isFinite(f.speedMps) && f.speedMps >= 0) this.withSpeed++;
    if (Number.isFinite(f.accuracyM)) this.acc[Math.min(100, Math.max(0, Math.round(f.accuracyM)))]!++;
    if (this.lastAt !== null) this.interval[Math.min(300, Math.max(0, Math.round((f.receivedAtMs - this.lastAt) / 100)))]!++;
    this.lastAt = f.receivedAtMs;
  }

  reset(): void {
    Object.assign(this, new GpsStats());
  }

  summary(): Record<string, string | number> {
    return {
      fixes: this.fixes,
      accepted: this.accepted,
      rejected: Object.entries(this.rejected).map(([k, v]) => `${k}:${v}`).join(" ") || "0",
      speedAvailablePct: this.fixes ? Math.round((100 * this.withSpeed) / this.fixes) : 0,
      accuracyMedianM: quantile(this.acc, 0.5),
      accuracyP90M: quantile(this.acc, 0.9),
      intervalMedianS: quantile(this.interval, 0.5) / 10,
      intervalP90S: quantile(this.interval, 0.9) / 10,
    };
  }
}

function quantile(h: Uint32Array, q: number): number {
  let n = 0;
  for (const c of h) n += c;
  if (!n) return 0;
  let seen = 0;
  for (let i = 0; i < h.length; i++) {
    seen += h[i]!;
    if (seen >= q * n) return i;
  }
  return h.length - 1;
}
