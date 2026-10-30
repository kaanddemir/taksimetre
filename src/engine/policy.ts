/**
 * Behaviours the official tariff does not specify. Each default is an assumption
 * (docs/TECHNICAL.md §3 Assumptions), isolated here so it can be changed after field tests.
 */
export interface FarePolicy {
  /** Keep a partly completed 100 m / 1 min step when switching between distance and time charging. */
  carryPartialSteps: boolean;
  /** Mode used when speed equals the crossover speed exactly. */
  atCrossover: "distance" | "time";
  /** Minimum time the finalized fare must stay displayed before returning to SERBEST. */
  minFareDisplayMs: number;
}

export const DEFAULT_POLICY: Readonly<FarePolicy> = Object.freeze({
  carryPartialSteps: true,
  atCrossover: "distance",
  minFareDisplayMs: 10_000,
});
