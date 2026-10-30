/** Official İBB taxi categories (İBB Meclis Kararı 813 wording). */
export type TariffCategory =
  | "yellow-c" // En az "C" segment ve üzeri sarı renk taksiler (UKOME 2022/6-20)
  | "turquoise-d" // "D" segment ve 8+1 koltuk kapasiteli turkuaz renk taksiler (UKOME 2022/6-20)
  | "yellow-8pax" // Şoför hariç 8 kişi kapasiteli sarı renk taksiler (UKOME 2022/12-19.B)
  | "black-ef"; // En az "E"/"F" segment ve 8+1 koltuk kapasiteli siyah renk taksiler (UKOME 2022/6-20)

export const TARIFF_CATEGORIES: readonly TariffCategory[] = [
  "yellow-c",
  "turquoise-d",
  "yellow-8pax",
  "black-ef",
];

export interface TariffSource {
  title: string;
  issuer: string;
  decision: string;
  decisionDate: string; // YYYY-MM-DD
  url: string;
  verifiedOn: string; // YYYY-MM-DD, date the values were checked against the source
  confidence: "high" | "medium" | "low";
}

/**
 * One tariff version for one category. All money is integer kuruş (1 TL = 100 kuruş).
 * The billing parameters are the officially published unit values. `reference` holds the
 * published per-km / per-hour rates, which are metadata only and are NOT used for billing.
 */
export interface Tariff {
  id: string;
  category: TariffCategory;
  displayName: { tr: string; en: string };
  officialDescription: string;
  ukomeDecision: string;
  effectiveFrom: string; // YYYY-MM-DD, Istanbul local date
  currency: "TRY";
  openingFareKurus: number;
  distanceStepMeters: number;
  distanceStepFareKurus: number;
  timeStepSeconds: number;
  timeStepFareKurus: number;
  crossoverMetersPerHour: number; // 12.50 km/h -> 12500
  minimumFareKurus: number;
  reference: { perKmKurus: number; perHourKurus: number };
  source: TariffSource;
}
