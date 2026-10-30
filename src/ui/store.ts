import { IDLE, transition, type MeterCommand, type MeterErrorCode, type MeterState } from "../engine/meter.ts";
import type { Measurement } from "../engine/measurement.ts";
import { selectTariff } from "../tariff/select.ts";
import { TARIFF_CATEGORIES, type Tariff, type TariffCategory } from "../tariff/types.ts";
import type { GpsPhase } from "../gps/live.ts";
import type { Clock } from "./clock.ts";

/** How long the BİTİR button stays armed waiting for the confirming second tap. */
export const FINISH_CONFIRM_MS = 4_000;

export interface AppState {
  /** The engine's state, the single source of truth for every fare value. */
  readonly meter: MeterState;
  /** Category for the next journey. The active journey keeps its own frozen tariff. */
  readonly category: TariffCategory;
  readonly finishArmedAt: number | null;
  readonly lastError: MeterErrorCode | "NO_TARIFF" | null;
  /** Location-feed status (display only; never affects fares). */
  readonly gps: GpsPhase;
}

type Listener = (s: AppState) => void;

/**
 * Thin wrapper around the engine's pure `transition`. It adds only UI concerns
 * (category choice, two-step finish confirmation, last error) and never computes fares.
 */
export class MeterStore {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(
    private readonly clock: Clock,
    private readonly tariffs: readonly Tariff[],
    private readonly today: () => string,
    category: TariffCategory = "yellow-c",
  ) {
    this.state = { meter: IDLE, category, finishArmedAt: null, lastError: null, gps: "off" };
  }

  get(): AppState {
    return this.state;
  }
  now(): number {
    return this.clock.now();
  }
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  /** Tariff that a journey started now would use, or undefined if none is in force. */
  tariffFor(category: TariffCategory): Tariff | undefined {
    return selectTariff(this.tariffs, category, this.today());
  }

  private dispatch(cmd: MeterCommand): boolean {
    const r = transition(this.state.meter, cmd);
    if (r.ok) this.set({ meter: r.state, lastError: null, finishArmedAt: null });
    else this.set({ lastError: r.error });
    return r.ok;
  }

  cycleCategory(): boolean {
    if (this.state.meter.status !== "SERBEST") {
      this.set({ lastError: "INVALID_TRANSITION" });
      return false;
    }
    const i = TARIFF_CATEGORIES.indexOf(this.state.category);
    this.set({ category: TARIFF_CATEGORIES[(i + 1) % TARIFF_CATEGORIES.length]!, lastError: null });
    return true;
  }

  /** `atMs` lets the GPS layer start the meter at the exact time of the first usable fix. */
  start(atMs: number = this.clock.now()): boolean {
    const tariff = this.tariffFor(this.state.category);
    if (!tariff) {
      this.set({ lastError: "NO_TARIFF" });
      return false;
    }
    return this.dispatch({ type: "start", tariff, atMs });
  }

  /** First call arms, a second call within FINISH_CONFIRM_MS finalizes. */
  requestFinish(): boolean {
    if (this.state.meter.status !== "MESGUL") return this.dispatch({ type: "finalize", atMs: this.clock.now() });
    const now = this.clock.now();
    const armed = this.state.finishArmedAt;
    if (armed !== null && now - armed <= FINISH_CONFIRM_MS) {
      const m = this.state.meter;
      return this.dispatch({ type: "finalize", atMs: Math.max(now, m.journey.lastAtMs) });
    }
    this.set({ finishArmedAt: now, lastError: null });
    return false;
  }

  /** Clears an expired arm so the button label returns to normal. */
  expireArm(): void {
    const a = this.state.finishArmedAt;
    if (a !== null && this.clock.now() - a > FINISH_CONFIRM_MS) this.set({ finishArmedAt: null });
  }

  resume(atMs: number = this.clock.now()): boolean {
    return this.dispatch({ type: "resume", atMs });
  }

  /** Unknown motion up to `atMs`: recorded by the engine, never charged. */
  gap(atMs: number): boolean {
    return this.dispatch({ type: "gap", atMs });
  }

  setGps(gps: GpsPhase): void {
    if (gps !== this.state.gps) this.set({ gps });
  }

  /** Installs a validated, restored meter state. Only allowed when idle. */
  restore(meter: MeterState): boolean {
    if (this.state.meter.status !== "SERBEST") return false;
    this.set({ meter, lastError: null, finishArmedAt: null });
    return true;
  }

  clear(): boolean {
    return this.dispatch({ type: "clear", atMs: this.clock.now() });
  }

  /** Entry point for normalized measurements (GPS layer or dev simulator). */
  measure(m: Measurement): boolean {
    return this.dispatch({ type: "measure", measurement: m });
  }
}
