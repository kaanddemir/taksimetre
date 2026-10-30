import { parsePdf } from "../scripts/tariff-check/parse.ts";
import { MAX_PDF_BYTES, MAX_INDEX_BYTES } from "../scripts/tariff-check/security.ts";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { exitCode, renderMarkdown, runCheck, toJson, type CheckInput } from "../scripts/tariff-check/check.ts";
import { extractLines, joinCells, PdfError } from "../scripts/tariff-check/pdf-text.ts";
import {
  categoryOf,
  compareTariffs,
  findTariffLinks,
  formatValue,
  kmhToMetersPerHour,
  parseOfficialTariff,
  tlToKurus,
  trDate,
  VerifyError,
} from "../scripts/tariff-check/tariff.ts";
import { ISTANBUL_TARIFFS } from "../src/tariff/istanbul.ts";
import type { Tariff } from "../src/tariff/types.ts";

/** Real documents, retrieved from İBB TUHİM on 2026-10-31. */
const FIX = new URL("./fixtures/tariff/", import.meta.url);
const OFFICIAL_PDF = readFileSync(new URL("ibb-taksi-ucret-tarifesi-2026-07-20.pdf", FIX));
const INDEX_HTML = readFileSync(new URL("tuhim-ucret-tarifeler.html", FIX), "utf8");
const INDEX_URL = "https://tuhim.ibb.gov.tr/ucret-tarifeler/";
const PDF_URL = "https://tuhim.ibb.gov.tr/media/27494/taksi-ta%C5%9F%C4%B1mac%C4%B1l%C4%B1%C4%9F%C4%B1-%C3%BCcret-tarifesi.pdf";
const LINES = extractLines(OFFICIAL_PDF);

/** A one-page PDF with a Flate-compressed content stream and a WinAnsi font. */
function makePdf(content: string, { compress = true, extra = "" } = {}): Buffer {
  const data = compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const parts: Buffer[] = [
    Buffer.from(
      "%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n" +
        "3 0 obj\n<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>\nendobj\n" +
        `4 0 obj\n<</Length ${data.length}${compress ? "/Filter/FlateDecode" : ""}>>\nstream\n`,
      "latin1",
    ),
    data,
    Buffer.from(`\nendstream\nendobj\n5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>\nendobj\n${extra}%%EOF\n`, "latin1"),
  ];
  return Buffer.concat(parts);
}

describe("PDF text extraction", () => {
  it("reads the official İBB document, including Turkish characters and split numbers", () => {
    expect(LINES[0]).toBe("20.07.2026 TARİHİNDEN İTİBAREN GEÇERLİDİR");
    expect(LINES[1]).toBe("17.07.2026 Tarih ve 813 Sayılı İBB Meclis Kararı");
    expect(LINES).toContain("71,94 TL 47,92 TL/KM 598,90 TL/Saat 100 Metre 4,80 TL 1 Dakika 9,98 TL 12,50 Km/Saat");
    expect(LINES).toContain("122,30 TL 81,46 TL/KM 1018,12 TL/Saat 100 Metre 8,15 TL 1 Dakika 16,96 TL 12,50 Km/Saat");
    expect(LINES).toContain("YOLCULUK BAŞINA MİNİMUM ÜCRET 400,00 TL");
  });

  it("handles positioning, TJ arrays, escapes and line grouping", () => {
    const pdf = makePdf(
      "BT /F1 12 Tf 1 0 0 1 50 700 Tm (Hello) Tj 100 0 Td [(W) 20 (orld)] TJ ET\n" +
        "BT /F1 12 Tf 14 TL 1 0 0 1 50 600 Tm (\\(a\\)) Tj T* (\\374\\351) Tj ET\n" + // \374 = ü, \351 = é in WinAnsi
        "q 1 0 0 1 0 -100 cm BT /F1 12 Tf 1 0 0 1 50 600 Tm (moved by cm) Tj ET Q",
    );
    expect(extractLines(pdf)).toEqual(["Hello World", "(a)", "üé", "moved by cm"]);
  });

  it("joins numeric fragments only", () => {
    expect(joinCells(["23", "0", ",00 TL"])).toBe("230,00 TL");
    expect(joinCells(["100 Metre", "4,80", "TL"])).toBe("100 Metre 4,80 TL");
  });

  it("rejects what it cannot read", () => {
    expect(() => extractLines(Buffer.from("<html>not found</html>"))).toThrow(PdfError);
    expect(() => extractLines(makePdf("BT ET", { extra: "6 0 obj\n<</Filter/Standard>>\nendobj\ntrailer <</Encrypt 6 0 R>>\n" }))).toThrow(/encrypted/);
    expect(() => extractLines(Buffer.from("%PDF-1.4\n%%EOF"))).toThrow(/no pages/);
    expect(extractLines(makePdf("q 100 0 0 100 0 0 cm /Im1 Do Q"))).toEqual([]); // scanned image: no text
  });
});

describe("official document discovery", () => {
  it("finds exactly the taxi tariff on the real TUHİM index (not dolmuş, sea taxi or others)", () => {
    expect(findTariffLinks(INDEX_HTML, INDEX_URL)).toEqual([{ url: PDF_URL, label: "Taksi Taşımacılığı Ücret Tarifesi" }]);
  });

  it("collapses duplicate links, resolves relative URLs and reports competing documents", () => {
    const html = `<a href="/media/1/taksi-taşımacılığı-ücret-tarifesi.pdf">x</a><a href="../media/1/taksi-taşımacılığı-ücret-tarifesi.pdf" title="Taksi Taşımacılığı Ücret Tarifesi">Taksi</a>
      <a href="/media/2/taksi-tasimaciligi.pdf">Taksi Taşımacılığı Ücret Tarifesi 2027</a><a href="/media/3/taksi-dolmuş-taşımacılığı-ücret-tarifesi.pdf">Taksi Dolmuş</a>`;
    const links = findTariffLinks(html, INDEX_URL);
    expect(links.map((l) => l.url)).toEqual([
      "https://tuhim.ibb.gov.tr/media/1/taksi-ta%C5%9F%C4%B1mac%C4%B1l%C4%B1%C4%9F%C4%B1-%C3%BCcret-tarifesi.pdf",
      "https://tuhim.ibb.gov.tr/media/2/taksi-tasimaciligi.pdf",
    ]);
  });
});

describe("official tariff parsing", () => {
  it("parses all four categories from the official document, in exact integers", () => {
    const o = parseOfficialTariff(LINES);
    expect(o).toMatchObject({ decision: "İBB Meclis Kararı 813", decisionDate: "2026-07-17", effectiveFrom: "2026-07-20" });
    expect(o.categories.map((c) => c.category)).toEqual(["yellow-c", "turquoise-d", "yellow-8pax", "black-ef"]);
    expect(o.categories[3]).toMatchObject({
      ukomeDecision: "2022/6-20",
      openingFareKurus: 12_230,
      perKmKurus: 8_146,
      perHourKurus: 101_812,
      distanceStepMeters: 100,
      distanceStepFareKurus: 815,
      timeStepSeconds: 60,
      timeStepFareKurus: 1_696,
      crossoverMetersPerHour: 12_500,
      minimumFareKurus: 40_000,
    });
    expect(o.categories[2]!.ukomeDecision).toBe("2022/12-19.B");
  });

  it("converts amounts without floating point", () => {
    expect(tlToKurus("1.018,12")).toBe(101_812);
    expect(tlToKurus("0,29")).toBe(29); // 0.29 * 100 = 28.999999999999996 in floating point
    expect(tlToKurus("1018,12")).toBe(101_812);
    for (const bad of ["4,8", "4.80", "4,800", "1,018.12", "", "-1,00"]) expect(() => tlToKurus(bad)).toThrow(VerifyError);
    expect(kmhToMetersPerHour("12,50")).toBe(12_500);
    expect(kmhToMetersPerHour("12,5")).toBe(12_500);
    expect(kmhToMetersPerHour("15")).toBe(15_000);
    expect(trDate("17.07.2026")).toBe("2026-07-17");
    expect(() => trDate("31.02.2026")).toThrow(VerifyError);
  });

  it("recognises categories only when unambiguous", () => {
    expect(categoryOf('EN AZ “C” SEGMENT VE ÜZERİ SARI RENK TAKSİLER')).toBe("yellow-c");
    expect(categoryOf("LÜKS TAKSİLER")).toBeNull();
  });

  const fails = (lines: string[], msg: RegExp) => expect(() => parseOfficialTariff(lines)).toThrow(msg);
  const replace = (from: string, to: string) => LINES.map((l) => (l === from ? to : l));
  it("fails instead of guessing", () => {
    fails(LINES.filter((l) => !l.includes("GEÇERLİDİR")), /effective date line: expected exactly one, found 0/);
    fails([...LINES, "01.01.2027 TARİHİNDEN İTİBAREN GEÇERLİDİR"], /effective date line: expected exactly one, found 2/);
    fails(LINES.filter((l) => l !== "YOLCULUK BAŞINA MİNİMUM ÜCRET 265,00 TL"), /turquoise-d: expected one minimum fare/);
    // A changed layout (one value without a unit) no longer matches the strict row: unverifiable.
    fails(replace("71,94 TL 47,92 TL/KM 598,90 TL/Saat 100 Metre 4,80 TL 1 Dakika 9,98 TL 12,50 Km/Saat", "71,94 TL 47,92 TL/KM 598,90 TL/Saat 100 Metre 4,80 1 Dakika 9,98 TL 12,50 Km/Saat"), /yellow-c: expected one value row/);
    fails(replace("SİYAH RENK TAKSİLER", "LÜKS RENK TAKSİLER"), /unrecognised taxi category/);
    const dupe = LINES.map((l) => l.replace("TURKUAZ", "SARI").replace('“D” SEGMENT', '“C” SEGMENT'));
    fails(dupe, /yellow-c appears more than once/);
    // Values that contradict each other (a misread digit) fail the app's own plausibility rules.
    fails(replace("82,73 TL 55,10 TL/KM 688,72 TL/Saat 100 Metre 5,51 TL 1 Dakika 11,47 TL 12,50 Km/Saat", "82,73 TL 55,10 TL/KM 688,72 TL/Saat 100 Metre 6,51 TL 1 Dakika 11,47 TL 12,50 Km/Saat"), /turquoise-d: official values fail validation/);
    fails([], /expected exactly one/);
  });
});

describe("comparison with the app registry", () => {
  const official = parseOfficialTariff(LINES);

  it("the current registry matches the official document exactly", () => {
    const cmp = compareTariffs(official, ISTANBUL_TARIFFS);
    expect(cmp.map((c) => c.appTariffId)).toEqual(ISTANBUL_TARIFFS.map((t) => t.id));
    expect(cmp.flatMap((c) => c.rows.filter((r) => !r.equal))).toEqual([]);
    expect(cmp[0]!.rows.map((r) => r.field)).toEqual([
      "effectiveFrom", "decision", "decisionDate", "ukomeDecision", "openingFare", "distanceStep", "distanceStepFare",
      "timeStep", "timeStepFare", "crossoverSpeed", "minimumFare", "perKmRate", "perHourRate",
    ]);
  });

  it("reports each changed value", () => {
    const changed = { ...official, categories: official.categories.map((c) => (c.category === "yellow-c" ? { ...c, openingFareKurus: 7_995, minimumFareKurus: 25_000 } : c)) };
    const diffs = compareTariffs(changed, ISTANBUL_TARIFFS).flatMap((c) => c.rows.filter((r) => !r.equal).map((r) => `${c.category}.${r.field}`));
    expect(diffs).toEqual(["yellow-c.openingFare", "yellow-c.minimumFare"]);
  });

  it("a newer official decision differs in date and decision even if values are unchanged", () => {
    const newer = { ...official, decision: "İBB Meclis Kararı 999", decisionDate: "2027-01-10", effectiveFrom: "2027-01-15" };
    const diffs = compareTariffs(newer, ISTANBUL_TARIFFS)[0]!.rows.filter((r) => !r.equal).map((r) => r.field);
    expect(diffs).toEqual(["effectiveFrom", "decision", "decisionDate"]);
  });

  it("a category missing from the app is a difference in every field", () => {
    const partial = ISTANBUL_TARIFFS.filter((t) => t.category !== "black-ef");
    const black = compareTariffs(official, partial)[3]!;
    expect(black.appTariffId).toBeNull();
    expect(black.rows.every((r) => !r.equal && r.app === null)).toBe(true);
  });

  it("formats values for the report", () => {
    expect(formatValue("kurus", 101_812)).toBe("1018,12 TL");
    expect(formatValue("kurus", 5)).toBe("0,05 TL");
    expect(formatValue("speed", 12_500)).toBe("12,50 km/h");
    expect(formatValue("kurus", null)).toBe("—");
  });
});

describe("end-to-end check (injected network)", () => {
  type Route = Response | Error | "hang";
  function fakeFetch(routes: Record<string, Route | Route[]>) {
    const calls: string[] = [];
    const fetch: CheckInput["fetch"] = (url, init) => {
      calls.push(url);
      const r = routes[url];
      const next = Array.isArray(r) ? (r.length > 1 ? r.shift()! : r[0]!) : r;
      if (next === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
      if (next === "hang") return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      if (next instanceof Error) return Promise.reject(next);
      const res = next.clone();
      if (next.url) Object.defineProperty(res, "url", { value: next.url }); // clone() drops a faked final URL
      return Promise.resolve(res);
    };
    return { fetch, calls };
  }
  const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
  const pdf = (b: Buffer) => new Response(new Uint8Array(b), { headers: { "content-type": "application/pdf", "last-modified": "Mon, 20 Jul 2026 07:14:08 GMT" } });
  const now = new Date("2026-10-31T09:00:00Z");
  const run = (routes: Record<string, Route | Route[]>, extra: Partial<CheckInput> = {}) => {
    const f = fakeFetch(routes);
    return runCheck({ fetch: f.fetch, registry: ISTANBUL_TARIFFS, now, timeoutMs: 50, ...extra }).then((r) => ({ ...r, calls: f.calls }));
  };

  it("UP TO DATE: discovers the document, parses and matches", async () => {
    const r = await run({ [INDEX_URL]: html(INDEX_HTML), [PDF_URL]: pdf(OFFICIAL_PDF) });
    expect(r.status).toBe("UP TO DATE");
    expect(r.document).toMatchObject({ url: PDF_URL, bytes: OFFICIAL_PDF.length, lastModified: "Mon, 20 Jul 2026 07:14:08 GMT" });
    expect(r.document!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.notes).toEqual([]);
    expect(exitCode(r.status)).toBe(0);
    const md = renderMarkdown(r, false);
    expect(md).toContain("UP TO DATE");
    expect(md).toContain("İBB Meclis Kararı 813, dated 2026-07-17");
    expect(md).not.toContain("| = |"); // summary lists differences only
    expect(renderMarkdown(r, true)).toContain("| openingFare | 71,94 TL | 71,94 TL | = |");
    expect(JSON.parse(toJson(r))).toMatchObject({ status: "UP TO DATE", differences: 0 });
  });

  it("CHANGES FOUND: verified official values differ from the app", async () => {
    const registry: Tariff[] = ISTANBUL_TARIFFS.map((t) => (t.category === "turquoise-d" ? { ...t, minimumFareKurus: 26_000 } : t));
    const r = await run({ [INDEX_URL]: html(INDEX_HTML), [PDF_URL]: pdf(OFFICIAL_PDF) }, { registry });
    expect(r.status).toBe("CHANGES FOUND");
    expect(r.differences).toBe(1);
    expect(exitCode(r.status)).toBe(1);
    expect(renderMarkdown(r, false)).toContain("| minimumFare | 265,00 TL | 260,00 TL | **≠** |");
  });

  const unable = async (routes: Record<string, Route | Route[]>, problem: RegExp, extra: Partial<CheckInput> = {}) => {
    const r = await run(routes, extra);
    expect(r.status).toBe("UNABLE TO VERIFY");
    expect(r.problems.join("\n")).toMatch(problem);
    expect(exitCode(r.status)).toBe(2);
    expect(renderMarkdown(r, false)).toContain("This is not evidence that the app is up to date");
    return r;
  };

  it("UNABLE TO VERIFY: server errors (retried), missing pages, timeouts and network failures", async () => {
    const r = await unable({ [INDEX_URL]: new Response("", { status: 503 }) }, /HTTP 503/);
    expect(r.calls).toHaveLength(3);
    const r404 = await unable({}, /HTTP 404/);
    expect(r404.calls).toHaveLength(1);
    await unable({ [INDEX_URL]: "hang" }, /timeout/);
    await unable({ [INDEX_URL]: new Error("getaddrinfo ENOTFOUND") }, /network error/);
  });

  it("UNABLE TO VERIFY: a response redirected away from İBB", async () => {
    const moved = new Response("<html></html>", { headers: { "content-type": "text/html" } });
    Object.defineProperty(moved, "url", { value: "https://example.com/parked" });
    await unable({ [INDEX_URL]: moved }, /not an official İBB address/);
  });

  it("recovers from a transient error", async () => {
    const r = await run({ [INDEX_URL]: [new Response("", { status: 502 }), html(INDEX_HTML)], [PDF_URL]: pdf(OFFICIAL_PDF) });
    expect(r.status).toBe("UP TO DATE");
  });

  it("UNABLE TO VERIFY: index without a link, or with competing documents", async () => {
    await unable({ [INDEX_URL]: html("<p>Bakım çalışması</p>") }, /no taxi tariff document link/);
    const two = INDEX_HTML + '<a href="/media/99999/taksi-taşımacılığı-ücret-tarifesi-2027.pdf">Taksi Taşımacılığı Ücret Tarifesi 2027</a>';
    await unable({ [INDEX_URL]: html(two) }, /2 different taxi tariff documents/);
  });

  it("UNABLE TO VERIFY: the document is not a readable tariff PDF", async () => {
    await unable({ [INDEX_URL]: html(INDEX_HTML), [PDF_URL]: html("<html>Sayfa bulunamadı</html>") }, /not a PDF \(content-type text\/html\)/);
    await unable({ [INDEX_URL]: html(INDEX_HTML), [PDF_URL]: pdf(makePdf("q 100 0 0 100 0 0 cm /Im1 Do Q")) }, /no extractable text/);
    await unable({ [INDEX_URL]: html(INDEX_HTML), [PDF_URL]: pdf(makePdf("BT /F1 12 Tf 1 0 0 1 50 700 Tm (Duyuru) Tj ET")) }, /effective date line/);
    await unable({ [INDEX_URL]: html(INDEX_HTML), [PDF_URL]: pdf(OFFICIAL_PDF.subarray(0, 40_000)) }, /.+/); // truncated download
  });

  it("UNABLE TO VERIFY: a manual URL outside İBB is refused without any request", async () => {
    for (const pdfUrl of ["https://example.com/taksi.pdf", "http://tuhim.ibb.gov.tr/x.pdf", "https://ibb.gov.tr.example.com/x.pdf", 'x"; echo pwned']) {
      const r = await unable({}, /not an official İBB address/, { pdfUrl });
      expect(r.calls).toEqual([]);
    }
  });

  it("a manual document URL skips discovery and is noted", async () => {
    const r = await run({ [PDF_URL]: pdf(OFFICIAL_PDF) }, { pdfUrl: PDF_URL });
    expect(r.status).toBe("UP TO DATE");
    expect(r.calls).toEqual([PDF_URL]);
    expect(r.indexUrl).toBeNull();
    expect(r.notes).toContain("Discovery skipped: the document URL was given manually.");
  });
});

describe("tariff checker security boundaries", () => {
  const now = new Date("2026-10-31T09:00:00Z");
  const run = (fetch: CheckInput["fetch"], extra: Partial<CheckInput> = {}) =>
    runCheck({ fetch, registry: ISTANBUL_TARIFFS, now, timeoutMs: 30, ...extra });

  it("rejects discovered HTTP, loopback and lookalike destinations before requesting them", async () => {
    for (const url of ["http://127.0.0.1/internal.pdf", "https://evil.example/tariff.pdf", "https://ibb.gov.tr.evil.example/tariff.pdf", "https://ibb.gov.tr:444/tariff.pdf", "https://user:password@ibb.gov.tr/tariff.pdf"]) {
      const calls: string[] = [];
      const r = await run(async (u, init) => {
        calls.push(u);
        expect(init?.redirect).toBe("manual");
        return new Response(`<a href="${url}">Taksi Taşımacılığı tarife</a>`);
      });
      expect(r.status).toBe("UNABLE TO VERIFY");
      expect(calls).toEqual([INDEX_URL]);
    }
  });

  it("checks every redirect before requesting it, including a later hop", async () => {
    const calls: string[] = [];
    const r = await run(async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: calls.length === 1 ? "/redirect" : "http://127.0.0.1/private" } });
    });
    expect(calls).toEqual([INDEX_URL, "https://tuhim.ibb.gov.tr/redirect"]);
    expect(r.problems.join()).toMatch(/not an official/);
  });

  it("accepts relative official redirects and uses the final URL as evidence", async () => {
    const final = "https://tuhim.ibb.gov.tr/final.pdf";
    const r = await run(async (url) => url === PDF_URL
      ? new Response(null, { status: 307, headers: { location: "/final.pdf" } })
      : new Response(new Uint8Array(OFFICIAL_PDF)), { pdfUrl: PDF_URL });
    expect(r.status).toBe("UP TO DATE");
    expect(r.document?.url).toBe(final);
  });

  it("bounds redirect loops and rejects missing destinations", async () => {
    let count = 0;
    const loop = await run(async () => { count++; return new Response(null, { status: 302, headers: { location: INDEX_URL } }); });
    expect(count).toBe(6);
    expect(loop.problems.join()).toMatch(/redirect limit/);
    const missing = await run(async () => new Response(null, { status: 302 }));
    expect(missing.problems.join()).toMatch(/no destination/);
  });

  it("rejects malformed URLs, userinfo, nonstandard ports and control characters without requests", async () => {
    for (const url of ["https://u:p@ibb.gov.tr/x.pdf", "https://ibb.gov.tr:444/x.pdf", "https://ibb.gov.tr/\nx.pdf", "https://ibb.gov.tr\\@evil.example/x.pdf"]) {
      let calls = 0;
      const r = await run(async () => { calls++; return new Response(); }, { pdfUrl: url });
      expect(calls).toBe(0);
      expect(r.status).toBe("UNABLE TO VERIFY");
    }
  });

  it("enforces advertised limits before reading and streamed limits without content-length", async () => {
    for (const pdf of [false, true]) {
      const max = pdf ? MAX_PDF_BYTES : MAX_INDEX_BYTES;
      let cancelled = false;
      const oversized = await run(async () => new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; },
      }), { headers: { "content-length": String(max + 1) } }), pdf ? { pdfUrl: PDF_URL } : {});
      expect(oversized.problems.join()).toMatch(/size limit/);
      expect(cancelled).toBe(true);
      cancelled = false;
      const streamed = await run(async () => new Response(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array(max)); c.enqueue(new Uint8Array(1)); },
        cancel() { cancelled = true; },
      })), pdf ? { pdfUrl: PDF_URL } : {});
      expect(streamed.problems.join()).toMatch(/size limit/);
      expect(cancelled).toBe(true);
    }
  });

  it("times out a stalled body after headers and cancels the reader", async () => {
    let cancelled = false;
    const r = await run(async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([37])); },
      cancel() { cancelled = true; },
    })));
    expect(r.problems.join()).toMatch(/timeout/);
    expect(cancelled).toBe(true);
  });

  it("times out even if a fetch implementation ignores abort", async () => {
    const r = await run(() => new Promise(() => {}));
    expect(r.problems.join()).toMatch(/timeout/);
  });

  it("never logs network exception details or retains URL credentials and parameters in reports", async () => {
    const r = await run(async () => { throw new Error("https://user:password@ibb.gov.tr/x?token=secret#fragment\n::error::oops\u001b[31m"); },
      { pdfUrl: "https://ibb.gov.tr/x?token=secret#fragment" });
    for (const output of [toJson(r), renderMarkdown(r, true)]) {
      expect(output).not.toMatch(/password|token=secret|fragment|::error::|\u001b/);
    }
    expect(r.problems).toEqual(["request failed: network error"]);
  });

  it("renders hostile Markdown, HTML, table delimiters and code fences as text", async () => {
    const r = await run(async () => new Response("", { status: 404 }));
    const attack = "[click](javascript:alert(1)) <img src=x> | owned\n# heading\n```\n::error::oops\u001b[31m";
    r.problems = [attack];
    r.candidates = [{ label: attack, url: "https://ibb.gov.tr/x?secret=hidden#hidden" }];
    r.text = [attack];
    const output = renderMarkdown(r, false);
    expect(output).not.toContain("<img");
    expect(output).not.toContain("[click](");
    expect(output).not.toContain("\n# heading");
    expect(output).not.toContain("\n```");
    expect(output).not.toContain("?secret=");
    expect(output).not.toContain("::error::");
    expect(output).not.toContain("\u001b");
    expect(renderMarkdown(r, true)).toContain("    [click]");
    expect(renderMarkdown(r, true)).not.toContain("\n```\n");
  });

  it("rejects decompression bombs, malformed tokens, excessive tokens and nested arrays", () => {
    expect(() => extractLines(makePdf(" ".repeat(4 * 1024 * 1024 + 1)))).toThrow(/decompression/);
    for (const content of ["<", "<123", "<xx>", ">", "}", "(", "(\\", "[".repeat(65), "q ".repeat(100_001)]) {
      expect(() => extractLines(makePdf(content))).toThrow(PdfError);
    }
  });

  it("bounds object-stream counts and CMap ranges before looping", () => {
    const objectStream = "6 0 obj\n<</Type/ObjStm/N 999999999/First 0/Length 1>>\nstream\nx\nendstream\nendobj\n";
    expect(() => extractLines(makePdf("BT ET", { extra: objectStream }))).toThrow(/object stream/);
    const cmap = "beginbfrange <0000> <ffffffff> <0041> endbfrange";
    const extra = `6 0 obj\n<</Length ${cmap.length}>>\nstream\n${cmap}\nendstream\nendobj\n`;
    const pdf = makePdf("BT /F1 12 Tf (x) Tj ET", { extra }).toString("latin1").replace("/Encoding/WinAnsiEncoding", "/ToUnicode 6 0 R");
    expect(() => extractLines(Buffer.from(pdf, "latin1"))).toThrow(/CMap range/);
  });

  it("terminates parsing at the hard deadline and still parses the official fixture", async () => {
    await expect(parsePdf(OFFICIAL_PDF, 1)).rejects.toThrow(/time limit/);
    const parsed = await parsePdf(OFFICIAL_PDF);
    expect(parsed.text).toEqual(LINES);
    expect(parsed.official).toEqual(parseOfficialTariff(LINES));
  });
});


describe("bounded HTML discovery", () => {
  it("handles many unterminated anchors without repeated body scans", () => {
    expect(findTariffLinks("<a>".repeat(100_000), INDEX_URL)).toEqual([]);
    expect(findTariffLinks("<a ".repeat(100_000), INDEX_URL)).toEqual([]);
  });

  it("rejects oversized anchor attributes and text before applying extraction expressions", () => {
    expect(() => findTariffLinks('<a title="' + "x".repeat(8192) + '">x</a>', INDEX_URL)).toThrow(/attributes exceed/);
    expect(() => findTariffLinks('<a href="/x.pdf">' + "<".repeat(65_536) + '</a>', INDEX_URL)).toThrow(/text exceeds/);
  });
});


describe("workflow CLI output", () => {
  it("writes sanitized reports and fixed stdout without echoing a hostile manual input", () => {
    const dir = mkdtempSync(join(tmpdir(), "taksimetre-security-"));
    try {
      const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings",
        new URL("../scripts/tariff-check/main.ts", import.meta.url).pathname,
        "--out", dir, "--pdf", "https://ibb.gov.tr.evil.invalid/x?token=private-value#fragment"], {
        encoding: "utf8", timeout: 5000,
        env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary.md"), GITHUB_OUTPUT: join(dir, "outputs.txt") },
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("UNABLE TO VERIFY\n");
      expect(result.stderr).toBe("");
      for (const name of ["report.md", "report.json", "text.txt", "summary.md", "outputs.txt"]) {
        expect(readFileSync(join(dir, name), "utf8")).not.toMatch(/private-value|token=|fragment/);
      }
      expect(readFileSync(join(dir, "outputs.txt"), "utf8")).toBe("status=UNABLE TO VERIFY\n");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
