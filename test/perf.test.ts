import { describe, expect, it } from "vitest";
import { generate } from "./replay/trace.ts";
import { replay } from "./replay/run.ts";

describe("performance (processor + engine, Node)", () => {
  it("8-hour journey at 1 Hz (28,800 fixes) processes quickly with bounded state", () => {
    const trace = generate({ name: "8h", seed: 5, legs: Array.from({ length: 96 }, (_, i) => ({ seconds: 300, kmh: [0, 15, 45, 8][i % 4]! })), noiseSigmaM: 4, accuracyM: 10, speedAvailable: true });
    const t0 = performance.now();
    const r = replay(trace);
    const ms = performance.now() - t0;
    console.log(`PERF 8h replay: ${trace.fixes.length} fixes in ${ms.toFixed(0)} ms (${((ms * 1000) / trace.fixes.length).toFixed(1)} µs/fix), fare err ${r.fareErrPct.toFixed(1)}%`);
    expect(ms).toBeLessThan(5_000);
  });
});
