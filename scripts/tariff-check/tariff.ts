/**
 * Pure logic of the tariff checker: find the official document link, parse the official tariff
 * text, and compare it with the app's registry. Everything here is deterministic and unit-tested
 * (test/tariff-check.test.ts); network and files live in check.ts / main.ts.
 */
import { selectTariff } from "../../src/tariff/select.ts";
import type { Tariff, TariffCategory } from "../../src/tariff/types.ts";
import { isIsoDate, validateTariff } from "../../src/tariff/validate.ts";

/** A problem that makes the official source unusable as evidence (→ UNABLE TO VERIFY). */
export class VerifyError extends Error {}

// ---------------------------------------------------------------- discovery

export interface DocLink {
  url: string;
  label: string;
}

const lowerTr = (s: string) => s.toLocaleLowerCase("tr");
const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

/**
 * Links on the TUHİM tariff index that point to the taxi ("Taksi Taşımacılığı") tariff PDF. Matching
 * uses the link title, text and file name, and excludes taxi-dolmuş, sea taxi and luxury taxi documents.
 * Duplicate links to the same URL count once.
 */
export function findTariffLinks(html: string, pageUrl: string): DocLink[] {
  const found = new Map<string, DocLink>();
  // Scan each anchor once. A lazy whole-anchor regex can repeatedly rescan an
  // unterminated document, turning a bounded HTML response into quadratic work.
  const opening = /<a\b/gi;
  const closing = /<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = opening.exec(html))) {
    const end = html.indexOf(">", opening.lastIndex);
    if (end < 0) break;
    if (end - opening.lastIndex > 8192) throw new VerifyError("index link attributes exceed size limit");
    const attrs = html.slice(opening.lastIndex, end);
    closing.lastIndex = end + 1;
    const close = closing.exec(html);
    if (!close) break;
    if (close.index - end > 65_536) throw new VerifyError("index link text exceeds size limit");
    const body = html.slice(end + 1, close.index);
    opening.lastIndex = closing.lastIndex;
    const href = /\bhref\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (!href) continue;
    const title = /\btitle\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
    const text = body.replace(/<[^<>]*>/g, " ");
    let url: URL;
    try {
      url = new URL(decodeEntities(href), pageUrl);
    } catch {
      continue;
    }
    if (!/\.pdf$/i.test(url.pathname)) continue;
    let file = url.pathname;
    try {
      file = decodeURIComponent(file);
    } catch {
      /* keep encoded */
    }
    const hay = lowerTr(`${decodeEntities(title)} ${decodeEntities(text)} ${file.replace(/[-_/]+/g, " ")}`).replace(/\s+/g, " ");
    if (!hay.includes("taksi taşımacılığı") || !hay.includes("tarife")) continue;
    if (/dolmuş|dolmus|deniz|lüks|luks/.test(hay)) continue;
    const label = (decodeEntities(text).replace(/\s+/g, " ").trim() || decodeEntities(title).trim() || file).slice(0, 120);
    if (!found.has(url.href)) found.set(url.href, { url: url.href, label });
  }
  return [...found.values()];
}

// ---------------------------------------------------------------- parsing

export interface OfficialCategory {
  category: TariffCategory;
  heading: string;
  ukomeDecision: string;
  openingFareKurus: number;
  perKmKurus: number;
  perHourKurus: number;
  distanceStepMeters: number;
  distanceStepFareKurus: number;
  timeStepSeconds: number;
  timeStepFareKurus: number;
  crossoverMetersPerHour: number;
  minimumFareKurus: number;
}

export interface OfficialTariff {
  decision: string; // "İBB Meclis Kararı 813"
  decisionDate: string; // YYYY-MM-DD
  effectiveFrom: string; // YYYY-MM-DD
  categories: OfficialCategory[];
}

/** "1.018,12" → 101812 kuruş, exact string arithmetic. Exactly two decimals required. */
export function tlToKurus(s: string): number {
  const m = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})$/.exec(s.trim());
  if (!m) throw new VerifyError(`not a TL amount: "${s}"`);
  return Number(m[1]!.replace(/\./g, "")) * 100 + Number(m[2]);
}

/** "12,50" km/h → 12500 m/h, exact. */
export function kmhToMetersPerHour(s: string): number {
  const m = /^(\d+)(?:,(\d{1,3}))?$/.exec(s.trim());
  if (!m) throw new VerifyError(`not a speed: "${s}"`);
  return Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
}

/** "17.07.2026" → "2026-07-17", validated. */
export function trDate(s: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : "";
  if (!isIsoDate(iso)) throw new VerifyError(`not a date: "${s}"`);
  return iso;
}

const norm = (s: string) => s.replace(/[“”„″]/g, '"').replace(/\s+/g, " ").trim();
const upperTr = (s: string) => s.toLocaleUpperCase("tr");

/** Category from a section heading; null when it is none of the four app categories. */
export function categoryOf(heading: string): TariffCategory | null {
  const h = upperTr(norm(heading));
  const has = (...w: string[]) => w.every((x) => h.includes(x));
  const hits: TariffCategory[] = [];
  if (has('"C" SEGMENT', "SARI")) hits.push("yellow-c");
  if (has('"D" SEGMENT', "TURKUAZ")) hits.push("turquoise-d");
  if (has("8 KİŞİ", "SARI")) hits.push("yellow-8pax");
  if (has('"E"/"F"', "SİYAH")) hits.push("black-ef");
  return hits.length === 1 ? hits[0]! : null;
}

const MONEY = String.raw`(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2})`;
const ROW = new RegExp(
  String.raw`^${MONEY} TL ${MONEY} TL/KM ${MONEY} TL/Saat (\d+) Metre ${MONEY} TL (\d+) Dakika ${MONEY} TL (\d+(?:,\d{1,3})?) Km/Saat$`,
  "i",
);
const MINIMUM = new RegExp(String.raw`^YOLCULUK BAŞINA MİNİMUM ÜCRET ${MONEY} TL$`, "i");
const SECTION = /^(\d{4}\/\d+)\s*-\s*(\d+(?:\.[A-ZÇĞİÖŞÜ])?) SAYILI UKOME KARAR\S* .*?BELİRLENEN\s*;\s*(.*)$/i;
const EFFECTIVE = /^(\d{2}\.\d{2}\.\d{4}) TARİHİNDEN İTİBAREN GEÇERLİDİR$/i;
const DECISION = /^(\d{2}\.\d{2}\.\d{4}) Tarih ve (\d+) Sayılı İBB Meclis Kararı$/i;

/**
 * Parses the official tariff from the document's text lines. Strict: every category section must
 * contain exactly one complete value row and one minimum fare, each app category must appear exactly
 * once, and the values must pass the app's own tariff validation. Anything else throws VerifyError.
 */
export function parseOfficialTariff(rawLines: readonly string[]): OfficialTariff {
  const lines = rawLines.map(norm).filter(Boolean);
  const one = (re: RegExp, what: string) => {
    const hits = lines.map((l) => re.exec(l)).filter((m): m is RegExpExecArray => m !== null);
    if (hits.length !== 1) throw new VerifyError(`${what}: expected exactly one, found ${hits.length}`);
    return hits[0]!;
  };
  const effectiveFrom = trDate(one(EFFECTIVE, "effective date line")[1]!);
  const d = one(DECISION, "council decision line");
  const decisionDate = trDate(d[1]!);
  const decision = `İBB Meclis Kararı ${d[2]}`;

  const starts = lines.flatMap((l, i) => (SECTION.test(l) ? [i] : []));
  if (!starts.length) throw new VerifyError("no tariff sections (UKOME headings) found");
  const categories: OfficialCategory[] = [];
  starts.forEach((start, k) => {
    const block = lines.slice(start, starts[k + 1] ?? lines.length);
    const s = SECTION.exec(block[0]!)!;
    // The heading may wrap onto the next line(s) before the column header.
    const headEnd = block.findIndex((l, i) => i > 0 && /^Açılış(\s|$)/i.test(l));
    if (headEnd < 0) throw new VerifyError(`section "${block[0]}": column header not found`);
    const heading = [s[3]!, ...block.slice(1, headEnd)].join(" ").trim();
    const category = categoryOf(heading);
    if (!category) throw new VerifyError(`unrecognised taxi category: "${heading}"`);
    const rows = block.map((l) => ROW.exec(l)).filter((m): m is RegExpExecArray => m !== null);
    if (rows.length !== 1) throw new VerifyError(`${category}: expected one value row, found ${rows.length}`);
    const mins = block.map((l) => MINIMUM.exec(l)).filter((m): m is RegExpExecArray => m !== null);
    if (mins.length !== 1) throw new VerifyError(`${category}: expected one minimum fare, found ${mins.length}`);
    const r = rows[0]!;
    categories.push({
      category,
      heading,
      ukomeDecision: `${s[1]}-${s[2]}`,
      openingFareKurus: tlToKurus(r[1]!),
      perKmKurus: tlToKurus(r[2]!),
      perHourKurus: tlToKurus(r[3]!),
      distanceStepMeters: Number(r[4]),
      distanceStepFareKurus: tlToKurus(r[5]!),
      timeStepSeconds: Number(r[6]) * 60,
      timeStepFareKurus: tlToKurus(r[7]!),
      crossoverMetersPerHour: kmhToMetersPerHour(r[8]!),
      minimumFareKurus: tlToKurus(mins[0]![1]!),
    });
  });
  for (const c of new Set(categories.map((c) => c.category))) {
    if (categories.filter((x) => x.category === c).length > 1) throw new VerifyError(`${c} appears more than once`);
  }
  const official: OfficialTariff = { decision, decisionDate, effectiveFrom, categories };
  // Plausibility with the app's own rules (unit fares vs published rates, minimum ≥ opening, …).
  for (const c of categories) {
    const errors = validateTariff(toTariff(official, c, "https://tuhim.ibb.gov.tr/"));
    if (errors.length) throw new VerifyError(`${c.category}: official values fail validation (${errors.join("; ")})`);
  }
  return official;
}

/** The official values in the app's Tariff shape (used for validation and in the report). */
export function toTariff(o: OfficialTariff, c: OfficialCategory, url: string): Tariff {
  return {
    id: `official-${c.category}`,
    category: c.category,
    displayName: { tr: c.heading, en: c.heading },
    officialDescription: c.heading,
    ukomeDecision: c.ukomeDecision,
    effectiveFrom: o.effectiveFrom,
    currency: "TRY",
    openingFareKurus: c.openingFareKurus,
    distanceStepMeters: c.distanceStepMeters,
    distanceStepFareKurus: c.distanceStepFareKurus,
    timeStepSeconds: c.timeStepSeconds,
    timeStepFareKurus: c.timeStepFareKurus,
    crossoverMetersPerHour: c.crossoverMetersPerHour,
    minimumFareKurus: c.minimumFareKurus,
    reference: { perKmKurus: c.perKmKurus, perHourKurus: c.perHourKurus },
    source: { title: "", issuer: "İBB", decision: o.decision, decisionDate: o.decisionDate, url, verifiedOn: o.effectiveFrom, confidence: "high" },
  };
}

// ---------------------------------------------------------------- comparison

export type FieldKind = "kurus" | "meters" | "seconds" | "speed" | "text" | "date";
export interface FieldRow {
  field: string;
  kind: FieldKind;
  official: string | number;
  app: string | number | null;
  equal: boolean;
}
export interface CategoryComparison {
  category: TariffCategory;
  appTariffId: string | null;
  rows: FieldRow[];
}

export const CATEGORIES: readonly TariffCategory[] = ["yellow-c", "turquoise-d", "yellow-8pax", "black-ef"];

/**
 * Compares each official category with the app tariff in force on the official effective date.
 * All values are integers or exact strings, so equality is exact. A category missing on either
 * side is a difference.
 */
export function compareTariffs(o: OfficialTariff, registry: readonly Tariff[]): CategoryComparison[] {
  return CATEGORIES.map((category) => {
    const c = o.categories.find((x) => x.category === category);
    const app = selectTariff(registry, category, o.effectiveFrom);
    const row = (field: string, kind: FieldKind, official: string | number | undefined, appValue: string | number | undefined): FieldRow => ({
      field,
      kind,
      official: official ?? "(missing in official document)",
      app: appValue ?? null,
      equal: official !== undefined && appValue !== undefined && official === appValue,
    });
    return {
      category,
      appTariffId: app?.id ?? null,
      rows: [
        row("effectiveFrom", "date", o.effectiveFrom, app?.effectiveFrom),
        row("decision", "text", o.decision, app?.source.decision),
        row("decisionDate", "date", o.decisionDate, app?.source.decisionDate),
        row("ukomeDecision", "text", c?.ukomeDecision, app?.ukomeDecision),
        row("openingFare", "kurus", c?.openingFareKurus, app?.openingFareKurus),
        row("distanceStep", "meters", c?.distanceStepMeters, app?.distanceStepMeters),
        row("distanceStepFare", "kurus", c?.distanceStepFareKurus, app?.distanceStepFareKurus),
        row("timeStep", "seconds", c?.timeStepSeconds, app?.timeStepSeconds),
        row("timeStepFare", "kurus", c?.timeStepFareKurus, app?.timeStepFareKurus),
        row("crossoverSpeed", "speed", c?.crossoverMetersPerHour, app?.crossoverMetersPerHour),
        row("minimumFare", "kurus", c?.minimumFareKurus, app?.minimumFareKurus),
        row("perKmRate", "kurus", c?.perKmKurus, app?.reference.perKmKurus),
        row("perHourRate", "kurus", c?.perHourKurus, app?.reference.perHourKurus),
      ],
    };
  });
}

/** Human-readable value: kuruş as "71,94 TL", speeds as "12,50 km/h", etc. */
export function formatValue(kind: FieldKind, v: string | number | null): string {
  if (v === null) return "—";
  if (typeof v === "string") return v;
  switch (kind) {
    case "kurus":
      return `${Math.trunc(v / 100)},${String(v % 100).padStart(2, "0")} TL`;
    case "meters":
      return `${v} m`;
    case "seconds":
      return `${v} s`;
    case "speed":
      return `${Math.trunc(v / 1000)},${String(v % 1000).padStart(3, "0").replace(/0$/, "")} km/h`;
    default:
      return String(v);
  }
}
