/**
 * Development-only journey simulator. Loaded with a dynamic import behind
 * import.meta.env.DEV, so it is not part of production builds. It feeds synthetic
 * normalized measurements to the same store/engine the GPS layer will use.
 */
import type { ScaledClock } from "../ui/clock.ts";
import type { MeterStore } from "../ui/store.ts";
import { SCENARIOS, syntheticMeasurement, type Scenario } from "./scenarios.ts";
import "./simulator.css";

export function mountSimulator(store: MeterStore, clock: ScaledClock): void {
  let scenario: Scenario = SCENARIOS[0]!;
  let paused = false;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "sim-toggle";
  toggle.textContent = "SİM";
  toggle.setAttribute("aria-label", "Geliştirici simülasyonu (sahte ölçümler)");
  toggle.setAttribute("aria-expanded", "false");

  const panel = document.createElement("div");
  panel.className = "sim-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <p class="sim-title">Simülasyon · sahte ölçüm, GPS değil</p>
    <label>Senaryo <select data-k="scenario">${SCENARIOS.map((s) => `<option value="${s.id}">${s.label}</option>`).join("")}</select></label>
    <div class="sim-rates" role="group" aria-label="Zaman hızı">
      ${[1, 10, 60].map((r) => `<button type="button" data-rate="${r}">×${r}</button>`).join("")}
      <button type="button" data-k="pause">Duraklat</button>
    </div>`;
  document.body.append(toggle, panel);

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });
  panel.querySelector<HTMLSelectElement>("[data-k=scenario]")!.addEventListener("change", (e) => {
    scenario = SCENARIOS.find((s) => s.id === (e.target as HTMLSelectElement).value) ?? scenario;
  });
  const rateButtons = [...panel.querySelectorAll<HTMLButtonElement>("[data-rate]")];
  const paintRates = () => rateButtons.forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.rate) === clock.getRate())));
  rateButtons.forEach((b) => b.addEventListener("click", () => { clock.setRate(Number(b.dataset.rate)); paintRates(); }));
  paintRates();
  const pauseBtn = panel.querySelector<HTMLButtonElement>("[data-k=pause]")!;
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Sürdür" : "Duraklat";
  });

  // Exposed for Playwright and manual debugging in dev only.
  (window as unknown as { __sim: unknown }).__sim = {
    setScenario: (id: string) => (scenario = SCENARIOS.find((s) => s.id === id) ?? scenario),
    setRate: (r: number) => { clock.setRate(r); paintRates(); },
    pause: (p: boolean) => (paused = p),
    /** Skips virtual time by `ms` and feeds one reading covering it (paused simulator only). */
    feed: (distanceMm: number, ms: number, speedKmh: number) => {
      clock.skip(ms);
      return store.measure({ atMs: clock.now(), distanceMm, speedKmh });
    },
    store,
  };

  window.setInterval(() => {
    const s = store.get().meter;
    if (paused || s.status !== "MESGUL") return;
    const m = syntheticMeasurement(scenario, s.journey.startedAtMs, s.journey.lastAtMs, clock.now());
    if (m) store.measure(m);
  }, 250);
}
