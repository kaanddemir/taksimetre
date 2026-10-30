/**
 * Orchestrates one tariff check: discover → download → extract → parse → compare → report.
 * Network access goes through the injected `fetch`, so every failure path is testable offline.
 */
import { createHash } from "node:crypto";
import type { Tariff } from "../../src/tariff/types.ts";
import { PdfError } from "./pdf-text.ts";
import { parsePdf } from "./parse.ts";
import { UrlError, officialUrl, safeUrl, safeText, markdown as md, sanitize, MAX_PDF_BYTES, MAX_INDEX_BYTES } from "./security.ts";
import {
  compareTariffs,
  findTariffLinks,
  formatValue,
  VerifyError,
  type CategoryComparison,
  type DocLink,
  type OfficialTariff,
} from "./tariff.ts";

export const DEFAULT_INDEX_URL = "https://tuhim.ibb.gov.tr/ucret-tarifeler/";
export type Status = "UP TO DATE" | "CHANGES FOUND" | "UNABLE TO VERIFY";

export interface CheckInput {
  fetch: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: "manual" }) => Promise<Response>;
  registry: readonly Tariff[];
  indexUrl?: string;
  /** Skips discovery (manual override when the index page changes). */
  pdfUrl?: string;
  now: Date;
  timeoutMs?: number;
}

export interface Report {
  status: Status;
  checkedAt: string;
  indexUrl: string | null;
  candidates: DocLink[];
  document: { url: string; sha256: string; bytes: number; lastModified: string | null } | null;
  official: OfficialTariff | null;
  comparisons: CategoryComparison[];
  differences: number;
  appSourceUrls: string[];
  problems: string[];
  notes: string[];
  /** Extracted text, for the downloadable report (empty when the PDF could not be read). */
  text: string[];
  pdf: Buffer | null;
}

/** One deadline covers redirects, headers and all streamed body bytes for each attempt. */
async function get(input: CheckInput, initialUrl: string, maxBytes: number): Promise<{ url: string; bytes: Buffer; headers: Headers }> {
  let last: Error = new VerifyError("request failed");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new VerifyError("request failed: timeout (aborted)")); ctl.abort(); }, Math.min(input.timeoutMs ?? 30_000, 30_000));
    });
    try {
      let url = officialUrl(initialUrl);
      for (let redirects = 0; ; redirects++) {
        const res = await Promise.race([input.fetch(url, { redirect: "manual", signal: ctl.signal,
          headers: { "user-agent": "Taksimetre tariff check (GitHub Actions, manual)" } }), expired]);
        if (res.url && officialUrl(res.url) !== url) {
          void res.body?.cancel().catch(() => undefined);
          throw new VerifyError("redirected away from İBB or followed an unexpected redirect");
        }
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          void res.body?.cancel().catch(() => undefined);
          if (redirects >= 5) throw new VerifyError("redirect limit exceeded");
          const location = res.headers.get("location");
          if (!location) throw new VerifyError("redirect has no destination");
          url = officialUrl(location, url); // validate BEFORE the next request
          continue;
        }
        if (!res.ok) {
          void res.body?.cancel().catch(() => undefined);
          last = new VerifyError(`HTTP ${res.status}`);
          if (res.status < 500) throw last;
          break;
        }
        const size = res.headers.get("content-length");
        if (size && (!/^\d+$/.test(size) || Number(size) > maxBytes)) {
          void res.body?.cancel().catch(() => undefined);
          throw new VerifyError("download size limit exceeded");
        }
        const reader = res.body?.getReader();
        const body = Buffer.allocUnsafe(maxBytes);
        let bytes = 0;
        try {
          if (reader) for (;;) {
            const chunk = await Promise.race([reader.read(), expired]);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxBytes) throw new VerifyError("download size limit exceeded");
            body.set(chunk.value, bytes - chunk.value.byteLength);
          }
        } finally {
          void reader?.cancel().catch(() => undefined);
        }
        return { url, bytes: body.subarray(0, bytes), headers: res.headers };
      }
    } catch (e) {
      // Network library errors can contain request URLs, credentials or control characters.
      if (e instanceof VerifyError) throw e;
      if (e instanceof UrlError) throw new VerifyError(e.message);
      last = new VerifyError("request failed: network error");
    } finally {
      clearTimeout(timer!);
      ctl.abort();
    }
  }
  throw last;
}

export async function runCheck(input: CheckInput): Promise<Report> {
  const report: Report = {
    status: "UNABLE TO VERIFY",
    checkedAt: input.now.toISOString(),
    indexUrl: input.pdfUrl ? null : (input.indexUrl ?? DEFAULT_INDEX_URL),
    candidates: [],
    document: null,
    official: null,
    comparisons: [],
    differences: 0,
    appSourceUrls: [...new Set(input.registry.map((t) => t.source.url))],
    problems: [],
    notes: [],
    text: [],
    pdf: null,
  };
  try {
    for (const u of [input.indexUrl, input.pdfUrl]) {
      if (u !== undefined) officialUrl(u);
    }
    let pdfUrl = input.pdfUrl;
    if (pdfUrl) report.notes.push("Discovery skipped: the document URL was given manually.");
    else {
      const res = await get(input, report.indexUrl!, MAX_INDEX_BYTES);
      const html = res.bytes.toString("utf8");
      report.candidates = findTariffLinks(html, res.url || report.indexUrl!);
      if (report.candidates.length === 0) throw new VerifyError("no taxi tariff document link found on the index page (page layout may have changed)");
      if (report.candidates.length > 1) throw new VerifyError(`${report.candidates.length} different taxi tariff documents are linked; cannot tell which one is current`);
      pdfUrl = report.candidates[0]!.url;
    }
    const res = await get(input, pdfUrl, MAX_PDF_BYTES);
    const buf = res.bytes;
    if (buf.length > MAX_PDF_BYTES) throw new VerifyError(`document too large (${buf.length} bytes)`);
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new VerifyError(`not a PDF (content-type ${res.headers.get("content-type") ?? "unknown"})`);
    report.pdf = buf;
    report.document = {
      url: res.url,
      sha256: createHash("sha256").update(buf).digest("hex"),
      bytes: buf.length,
      lastModified: res.headers.get("last-modified"),
    };
    const parsed = await parsePdf(buf);
    report.text = parsed.text;
    report.official = parsed.official;
    report.comparisons = compareTariffs(report.official, input.registry);
    report.differences = report.comparisons.reduce((n, c) => n + c.rows.filter((r) => !r.equal).length, 0);
    report.status = report.differences ? "CHANGES FOUND" : "UP TO DATE";
    if (!report.appSourceUrls.includes(pdfUrl)) report.notes.push("The official document URL differs from the URL stored in the app's tariff source (values are compared regardless).");
    if (report.official.effectiveFrom > input.now.toISOString().slice(0, 10)) report.notes.push(`The official tariff takes effect in the future (${report.official.effectiveFrom}).`);
  } catch (e) {
    if (!(e instanceof VerifyError || e instanceof PdfError)) report.problems.push(e instanceof UrlError ? e.message : "unexpected error while checking tariff");
    else report.problems.push(e.message);
    report.status = "UNABLE TO VERIFY";
  }
  const { pdf, ...printable } = report;
  printable.indexUrl = printable.indexUrl && safeUrl(printable.indexUrl);
  printable.candidates = printable.candidates.map((c) => ({ ...c, url: safeUrl(c.url) }));
  if (printable.document) printable.document.url = safeUrl(printable.document.url);
  printable.appSourceUrls = printable.appSourceUrls.map(safeUrl);
  return { ...sanitize(printable), pdf };
}

const ICON: Record<Status, string> = { "UP TO DATE": "✅", "CHANGES FOUND": "⚠️", "UNABLE TO VERIFY": "❓" };

/** Markdown for the job summary (`detailed` adds every compared field and the extracted text). */
export function renderMarkdown(r: Report, detailed: boolean): string {
  const out: string[] = [`# ${ICON[r.status]} Taxi tariff check: ${r.status}`, ""];
  out.push(`Checked ${md(r.checkedAt)} against the app registry (\`src/tariff/istanbul.ts\`). Nothing was changed.`, "");
  if (r.status === "UNABLE TO VERIFY") {
    out.push("**The official tariff could not be retrieved, read or validated. This is not evidence that the app is up to date.**", "");
  }
  if (r.problems.length) out.push("## Problems", ...r.problems.map((p) => `- ${md(p)}`), "");
  out.push("## Official source");
  if (r.indexUrl) out.push(`- Index page: ${md(safeUrl(r.indexUrl))}`);
  if (r.candidates.length) out.push(`- Taxi tariff links found: ${r.candidates.map((c) => `${md(c.label)}: ${md(safeUrl(c.url))}`).join(", ")}`);
  if (r.document) {
    out.push(`- Document: ${md(safeUrl(r.document.url))}`, `- SHA-256: \`${r.document.sha256}\` (${r.document.bytes} bytes)`);
    if (r.document.lastModified) out.push(`- Server Last-Modified: ${md(r.document.lastModified)}`);
  }
  if (r.official) out.push(`- Decision: ${md(r.official.decision)}, dated ${md(r.official.decisionDate)}`, `- Effective from: ${md(r.official.effectiveFrom)}`);
  out.push(`- App source URL(s): ${r.appSourceUrls.map((u) => md(safeUrl(u))).join(", ")}`, "");
  if (r.comparisons.length) {
    out.push("## Comparison", "", "| Category | App tariff | Result |", "|---|---|---|");
    for (const c of r.comparisons) {
      const diff = c.rows.filter((x) => !x.equal).length;
      out.push(`| ${md(c.category)} | ${md(c.appTariffId ?? "— (none in force)")} | ${diff ? `⚠️ ${diff} difference(s)` : "✅ match"} |`);
    }
    out.push("");
    for (const c of r.comparisons) {
      const rows = detailed ? c.rows : c.rows.filter((x) => !x.equal);
      if (!rows.length) continue;
      out.push(`### ${md(c.category)}`, "", "| Field | Official | App | |", "|---|---|---|---|");
      for (const x of rows) out.push(`| ${md(x.field)} | ${md(formatValue(x.kind, x.official))} | ${md(formatValue(x.kind, x.app))} | ${x.equal ? "=" : "**≠**"} |`);
      out.push("");
    }
  }
  if (r.notes.length) out.push("## Notes", ...r.notes.map((n) => `- ${md(n)}`), "");
  if (r.status === "CHANGES FOUND") {
    out.push("A person must review the official document and add a **new** tariff version to the registry (never edit a published one). This workflow does not change files.", "");
  }
  if (detailed && r.text.length) out.push("## Extracted document text", "", ...r.text.map((line) => `    ${safeText(line)}`), "");
  return out.join("\n");
}

/** JSON report (without the PDF bytes and text, which are separate files). */
export function toJson(r: Report): string {
  const { pdf: _pdf, text: _text, ...rest } = r;
  return JSON.stringify(sanitize(rest), null, 2) + "\n";
}

export const exitCode = (s: Status): number => (s === "UP TO DATE" ? 0 : s === "CHANGES FOUND" ? 1 : 2);
