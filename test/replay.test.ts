import { describe, expect, it } from "vitest";
import { replay, table, type ReplayResult } from "./replay/run.ts";
import { SCENARIOS } from "./replay/scenarios.ts";
import { generate } from "./replay/trace.ts";

const results: ReplayResult[] = SCENARIOS.map((s) => replay(generate(s)));
const out = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.REPLAY_OUT;
if (out) {
  const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { writeFileSync(p: string, s: string): void };
  fs.writeFileSync(out, table(results) + "\n");
}

describe("synthetic GPS replay (regression guards, not accuracy claims)", () => {
  it("is deterministic", () => {
    expect(SCENARIOS.map((s) => replay(generate(s)))).toEqual(results);
  });
  // Guards encode the measured behaviour so regressions are caught. They are NOT accuracy claims.
  // Over-charging is bounded more tightly than under-charging (the gap policy under-charges by design).
  it.each(results.map((r) => [r.name, r] as const))("%s", (_, r) => {
    expect(r.fareErrPct, "over-charge").toBeLessThanOrEqual(r.truthM === 0 ? 3 : 7);
    expect(r.fareErrPct, "under-charge").toBeGreaterThanOrEqual(-18);
    const spec = SCENARIOS.find((s) => s.name === r.name)!;
    if (r.truthM === 0) expect(r.appM, "stationary drift").toBeLessThan(spec.driftBudgetM ?? 400);
    else if (r.truthM / (r.truthSlowS + 1) > 2.3) expect(Math.abs(r.distErrPct), "distance").toBeLessThan(13);
  });
});
