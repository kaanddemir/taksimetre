import { describe, expect, it } from "vitest";
import { GpsProcessor } from "../src/gps/processor.ts";
import { GpsStats } from "../src/gps/stats.ts";
import { fix } from "./gps-helpers.ts";

describe("GPS stats (diag)", () => {
  it("aggregates counts, medians and reject reasons without storing positions", () => {
    const p = new GpsProcessor();
    const s = new GpsStats();
    const fixes = [fix(0, 0), fix(1000, 10, { speedMps: 10 }), fix(2000, 20, { accuracyM: 60 }), fix(1000, 20), fix(3000, 30, { accuracyM: 12 })];
    for (const f of fixes) s.record(f, p.process(f));
    expect(s.summary()).toMatchObject({ fixes: 5, accepted: 3, rejected: "inaccurate:1 duplicate:1", speedAvailablePct: 20, accuracyMedianM: 8, intervalMedianS: 1 });
    expect(JSON.stringify(s)).not.toMatch(/41\\.|28\\./);
  });
});
