/** Untrusted PDF and tariff parsing run off the main thread with a hard deadline. */
import { parentPort, workerData } from "node:worker_threads";
import { extractLines } from "./pdf-text.ts";
import { parseOfficialTariff } from "./tariff.ts";

try {
  const text = extractLines(Buffer.from(workerData as Uint8Array));
  if (!text.length) throw new Error("the PDF contains no extractable text (scanned image?)");
  const official = parseOfficialTariff(text);
  parentPort!.postMessage({ text, official });
} catch (e) {
  parentPort!.postMessage({ error: e instanceof Error ? e.message : "PDF processing failed" });
}
