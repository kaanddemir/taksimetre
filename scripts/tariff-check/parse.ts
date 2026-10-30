import { Worker } from "node:worker_threads";
import type { OfficialTariff } from "./tariff.ts";
import { PdfError } from "./pdf-text.ts";
import { MAX_PDF_BYTES } from "./security.ts";

export interface ParsedPdf { text: string[]; official: OfficialTariff }

/** Heap cap plus byte/operation caps in the parser; termination also bounds synchronous work. */
export function parsePdf(pdf: Buffer, timeoutMs = 5_000): Promise<ParsedPdf> {
  if (pdf.length > MAX_PDF_BYTES) return Promise.reject(new PdfError("PDF input size limit exceeded"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parse-worker.ts", import.meta.url), {
      workerData: pdf,
      execArgv: ["--experimental-strip-types", "--no-warnings"],
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    });
    let settled = false;
    const finish = (error?: Error, result?: ParsedPdf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new PdfError("PDF processing time limit exceeded")), Math.min(timeoutMs, 5_000));
    worker.once("message", (result: ParsedPdf & { error?: string }) => {
      if (result.error) finish(new PdfError(result.error)); else finish(undefined, result);
    });
    worker.once("error", () => finish(new PdfError("PDF worker failed or exceeded its memory limit")));
    worker.once("exit", () => finish(new PdfError("PDF worker exited without a result")));
  });
}
