import { describe, expect, it } from "vitest";
import { formatKurus, payable, readMeter } from "../src/engine/fare.ts";
import { IDLE, transition, type MeterCommand, type MeterState } from "../src/engine/meter.ts";
import { simulateJourney } from "../src/engine/simulate.ts";
import { readings, YELLOW } from "./helpers.ts";

function run(state: MeterState, ...cmds: MeterCommand[]): MeterState {
  for (const c of cmds) {
    const r = transition(state, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error}`);
    state = r.state;
  }
  return state;
}
const toll = { id: "fsm-bridge", label: "Köprü geçişi", amountKurus: 5_975 };

describe("payable fare", () => {
  it("applies the minimum at finalization only; live meter shows the meter fare", () => {
    const active = run(IDLE, { type: "start", tariff: YELLOW, atMs: 0 }, { type: "measure", measurement: { atMs: 120_000, distanceMm: 1_000_000, speedKmh: 30 } });
    expect(readMeter(active).meterFareKurus).toBe(11_994); // 71.94 + 10 × 4.80
    expect(payable(active)).toBeNull();
    const f = payable(run(active, { type: "finalize", atMs: 120_000 }))!;
    expect(f.meterFareKurus).toBe(11_994);
    expect(f.minimumApplied).toBe(true);
    expect(f.baseFareKurus).toBe(23_000);
    expect(f.totalKurus).toBe(23_000);
  });

  it("fare above minimum is unchanged", () => {
    const f = simulateJourney(YELLOW, readings([[600_000, 10_000_000, 60]]));
    expect(f.minimumApplied).toBe(false);
    expect(f.baseFareKurus).toBe(55_194);
  });

  it("extras are separate and added on top of max(meter, minimum)", () => {
    const f = simulateJourney(YELLOW, readings([[60_000, 500_000, 30]]), { extras: [toll] });
    expect(f.baseFareKurus).toBe(23_000);
    expect(f.extrasKurus).toBe(5_975);
    expect(f.totalKurus).toBe(28_975);
    expect(f.meterFareKurus).toBe(f.openingKurus + f.distanceKurus + f.timeKurus);
  });

  it("same extra cannot be applied twice; invalid extras rejected; allowed in UCRET", () => {
    let s = run(IDLE, { type: "start", tariff: YELLOW, atMs: 0 }, { type: "addCharge", charge: toll });
    expect(transition(s, { type: "addCharge", charge: toll }).error).toBe("DUPLICATE_CHARGE");
    expect(transition(s, { type: "addCharge", charge: { id: "x", label: "x", amountKurus: 0 } }).error).toBe("INVALID_CHARGE");
    expect(transition(s, { type: "addCharge", charge: { id: "x", label: "x", amountKurus: 1.5 } }).error).toBe("INVALID_CHARGE");
    expect(transition(IDLE, { type: "addCharge", charge: toll }).ok).toBe(false);
    s = run(s, { type: "finalize", atMs: 0 }, { type: "addCharge", charge: { id: "tunnel", label: "Tünel", amountKurus: 1_000 } });
    expect(payable(s)!.extrasKurus).toBe(6_975);
    expect(readMeter(s).meterFareKurus).toBe(7_194); // extras never enter the meter fare
  });

  it("breakdown is internally consistent for every category", () => {
    const f = simulateJourney(YELLOW, readings([[300_000, 2_345_678, 45], [123_456, 0, 0]]), { extras: [toll] });
    expect(f.distanceKurus).toBe(f.distanceSteps * YELLOW.distanceStepFareKurus);
    expect(f.timeKurus).toBe(f.timeSteps * YELLOW.timeStepFareKurus);
    expect(f.totalKurus).toBe(f.baseFareKurus + f.extrasKurus);
  });

  it("formats kuruş without floating point", () => {
    expect(formatKurus(55_194)).toBe("551.94");
    expect(formatKurus(5)).toBe("0.05");
    expect(formatKurus(23_000)).toBe("230.00");
  });
});
