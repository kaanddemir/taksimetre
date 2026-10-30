import { readMeter } from "../engine/fare.ts";
import type { LiveJourney } from "../gps/live.ts";
import type { MeterStore } from "./store.ts";

/** Opt-in (?diag) text block for field tests. Contains no coordinates. */
export function mountDiag(store: MeterStore, live: LiveJourney): void {
  const box = document.createElement("details");
  box.className = "diag";
  box.innerHTML = "<summary>diag</summary><pre></pre>";
  const pre = box.querySelector("pre")!;
  document.body.append(box);
  const paint = () => {
    const m = readMeter(store.get().meter);
    const rec = {
      status: m.status,
      tariff: m.tariffId,
      gps: store.get().gps,
      meterFareTL: (m.meterFareKurus / 100).toFixed(2),
      distanceKm: (m.totalDistanceMm / 1e6).toFixed(3),
      distanceModeKm: (m.distanceModeMm / 1e6).toFixed(3),
      measuredS: Math.round(m.totalDurationMs / 1000),
      slowS: Math.round(m.slowDurationMs / 1000),
      unknownS: Math.round(m.unknownDurationMs / 1000),
      gaps: m.gapCount,
      ...live.stats.summary(),
      ua: navigator.userAgent,
    };
    const txt = Object.entries(rec).map(([k, v]) => `${k}: ${v}`).join("\n");
    if (pre.textContent !== txt) pre.textContent = txt;
  };
  setInterval(paint, 1_000);
  paint();
}
