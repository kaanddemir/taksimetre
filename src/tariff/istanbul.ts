import type { Tariff, TariffSource } from "./types.ts";

const MECLIS_813: TariffSource = {
  title: "Taksi Taşımacılığı Segmentleri ve Ücret Tarifesi",
  issuer: "İstanbul Büyükşehir Belediyesi",
  decision: "İBB Meclis Kararı 813",
  decisionDate: "2026-07-17",
  url: "https://tuhim.ibb.gov.tr/media/27494/taksi-ta%C5%9F%C4%B1mac%C4%B1l%C4%B1%C4%9F%C4%B1-%C3%BCcret-tarifesi.pdf",
  verifiedOn: "2026-10-30",
  confidence: "high",
};

const COMMON = {
  effectiveFrom: "2026-07-20",
  currency: "TRY",
  distanceStepMeters: 100,
  timeStepSeconds: 60,
  crossoverMetersPerHour: 12_500,
  source: MECLIS_813,
} as const;

/** All Istanbul tariff versions. Add new versions here; never edit a published one. */
export const ISTANBUL_TARIFFS: readonly Tariff[] = [
  {
    ...COMMON,
    id: "ist-yellow-c-2026-07-20",
    category: "yellow-c",
    displayName: { tr: "Sarı taksi (C segment ve üzeri)", en: "Yellow taxi (C segment and above)" },
    officialDescription: 'En az "C" segment ve üzeri sarı renk taksiler',
    ukomeDecision: "2022/6-20",
    openingFareKurus: 7_194,
    distanceStepFareKurus: 480,
    timeStepFareKurus: 998,
    minimumFareKurus: 23_000,
    reference: { perKmKurus: 4_792, perHourKurus: 59_890 },
  },
  {
    ...COMMON,
    id: "ist-turquoise-d-2026-07-20",
    category: "turquoise-d",
    displayName: { tr: "Turkuaz taksi (D segment, 8+1)", en: "Turquoise taxi (D segment, 8+1)" },
    officialDescription: '"D" segment ve 8+1 koltuk kapasiteli turkuaz renk taksiler',
    ukomeDecision: "2022/6-20",
    openingFareKurus: 8_273,
    distanceStepFareKurus: 551,
    timeStepFareKurus: 1_147,
    minimumFareKurus: 26_500,
    reference: { perKmKurus: 5_510, perHourKurus: 68_872 },
  },
  {
    ...COMMON,
    id: "ist-yellow-8pax-2026-07-20",
    category: "yellow-8pax",
    displayName: { tr: "Sarı taksi (8 yolcu)", en: "Yellow taxi (8 passengers)" },
    officialDescription: "Şoför hariç 8 kişi kapasiteli sarı renk taksiler",
    ukomeDecision: "2022/12-19.B",
    openingFareKurus: 9_352,
    distanceStepFareKurus: 623,
    timeStepFareKurus: 1_297,
    minimumFareKurus: 30_000,
    reference: { perKmKurus: 6_229, perHourKurus: 77_856 },
  },
  {
    ...COMMON,
    id: "ist-black-ef-2026-07-20",
    category: "black-ef",
    displayName: { tr: "Siyah taksi (E/F segment, 8+1)", en: "Black taxi (E/F segment, 8+1)" },
    officialDescription: 'En az "E"/"F" segment ve 8+1 koltuk kapasiteli siyah renk taksiler',
    ukomeDecision: "2022/6-20",
    openingFareKurus: 12_230,
    distanceStepFareKurus: 815,
    timeStepFareKurus: 1_696,
    minimumFareKurus: 40_000,
    reference: { perKmKurus: 8_146, perHourKurus: 101_812 },
  },
];
