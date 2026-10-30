import { describe, expect, it } from "vitest";
import { ISTANBUL_TARIFFS } from "../src/tariff/istanbul.ts";
import { istanbulDate, selectTariff } from "../src/tariff/select.ts";
import { validateRegistry, validateTariff } from "../src/tariff/validate.ts";
import type { Tariff } from "../src/tariff/types.ts";
import { tariff, YELLOW } from "./helpers.ts";

/** Values transcribed verbatim (TL strings) from the official İBB PDF, Meclis Kararı 813. */
const OFFICIAL = {
  "yellow-c": ["71,94", "47,92", "598,90", "4,80", "9,98", "230,00", "2022/6-20"],
  "turquoise-d": ["82,73", "55,10", "688,72", "5,51", "11,47", "265,00", "2022/6-20"],
  "yellow-8pax": ["93,52", "62,29", "778,56", "6,23", "12,97", "300,00", "2022/12-19.B"],
  "black-ef": ["122,30", "81,46", "1018,12", "8,15", "16,96", "400,00", "2022/6-20"],
} as const;
const kurus = (tl: string) => Number(tl.replace(",", ""));

describe("official tariff data (verified against İBB Meclis Kararı 813)", () => {
  for (const [cat, [open, km, hour, step, min, minimum, ukome]] of Object.entries(OFFICIAL)) {
    it(`${cat} matches the official PDF`, () => {
      const t = tariff(cat as keyof typeof OFFICIAL);
      expect(t.openingFareKurus).toBe(kurus(open));
      expect(t.reference.perKmKurus).toBe(kurus(km));
      expect(t.reference.perHourKurus).toBe(kurus(hour));
      expect(t.distanceStepFareKurus).toBe(kurus(step));
      expect(t.timeStepFareKurus).toBe(kurus(min));
      expect(t.minimumFareKurus).toBe(kurus(minimum));
      expect(t.ukomeDecision).toBe(ukome);
      expect(t.distanceStepMeters).toBe(100);
      expect(t.timeStepSeconds).toBe(60);
      expect(t.crossoverMetersPerHour).toBe(12_500);
      expect(t.effectiveFrom).toBe("2026-07-20");
      expect(t.currency).toBe("TRY");
      expect(t.source.decision).toBe("İBB Meclis Kararı 813");
      expect(t.source.decisionDate).toBe("2026-07-17");
      expect(t.source.url).toContain("tuhim.ibb.gov.tr/media/27494");
      expect(t.source.confidence).toBe("high");
    });
  }

  it("has exactly the four official categories, once each", () => {
    expect(ISTANBUL_TARIFFS.map((t) => t.category).sort()).toEqual(["black-ef", "turquoise-d", "yellow-8pax", "yellow-c"]);
  });

  it("registry is valid", () => {
    expect(validateRegistry(ISTANBUL_TARIFFS)).toEqual([]);
  });

  it("documents the published step-vs-rate gap (unit fares are rounded)", () => {
    expect(YELLOW.distanceStepFareKurus * 10).toBe(4_800); // vs 4,792 per km
    expect(YELLOW.timeStepFareKurus * 60).toBe(59_880); // vs 59,890 per hour
  });
});

describe("tariff validation", () => {
  const bad = (patch: Partial<Tariff>) => validateTariff({ ...YELLOW, ...patch });
  it("rejects non-integer or non-positive money", () => {
    expect(bad({ openingFareKurus: 71.94 })).not.toEqual([]);
    expect(bad({ distanceStepFareKurus: 0 })).not.toEqual([]);
    expect(bad({ timeStepFareKurus: -1 })).not.toEqual([]);
    expect(bad({ minimumFareKurus: Number.NaN })).not.toEqual([]);
  });
  it("rejects invalid dates, currency, category and ids", () => {
    expect(bad({ effectiveFrom: "2026-02-30" })).not.toEqual([]);
    expect(bad({ effectiveFrom: "20.07.2026" })).not.toEqual([]);
    expect(bad({ currency: "EUR" as "TRY" })).not.toEqual([]);
    expect(bad({ category: "taxi" as "yellow-c" })).not.toEqual([]);
    expect(bad({ id: " " })).not.toEqual([]);
  });
  it("rejects contradictory values", () => {
    expect(bad({ distanceStepFareKurus: 600 })).toContain("distance step fare contradicts the published per-km rate");
    expect(bad({ timeStepFareKurus: 1_200 })).toContain("time step fare contradicts the published hourly rate");
    expect(bad({ crossoverMetersPerHour: 15_000 })).toContain("crossover speed contradicts hourly / per-km rates");
    expect(bad({ minimumFareKurus: 5_000 })).toContain("minimumFareKurus is below openingFareKurus");
  });
  it("rejects duplicate ids and duplicate category/date slots", () => {
    expect(validateRegistry([YELLOW, YELLOW]).some((e) => e.startsWith("duplicate id"))).toBe(true);
    expect(validateRegistry([YELLOW, { ...YELLOW, id: "other" }]).some((e) => e.includes("two versions"))).toBe(true);
  });
});

describe("tariff version selection", () => {
  const future: Tariff = { ...YELLOW, id: "ist-yellow-c-2027-01-15", effectiveFrom: "2027-01-15", openingFareKurus: 8_000, minimumFareKurus: 25_000 };
  const all = [...ISTANBUL_TARIFFS, future];
  it("selects by effective date", () => {
    expect(selectTariff(all, "yellow-c", "2026-07-19")).toBeUndefined();
    expect(selectTariff(all, "yellow-c", "2026-07-20")?.id).toBe("ist-yellow-c-2026-07-20");
    expect(selectTariff(all, "yellow-c", "2027-01-14")?.id).toBe("ist-yellow-c-2026-07-20");
    expect(selectTariff(all, "yellow-c", "2027-01-15")?.id).toBe("ist-yellow-c-2027-01-15");
    expect(selectTariff(all, "black-ef", "2027-06-01")?.id).toBe("ist-black-ef-2026-07-20");
  });
  it("rejects malformed dates", () => {
    expect(() => selectTariff(all, "yellow-c", "2026-13-01")).toThrow();
  });
  it("uses the Istanbul calendar date (UTC+3)", () => {
    expect(istanbulDate(Date.UTC(2026, 6, 19, 21, 0))).toBe("2026-07-20"); // 00:00 Istanbul
    expect(istanbulDate(Date.UTC(2026, 6, 19, 20, 59))).toBe("2026-07-19");
  });
});
