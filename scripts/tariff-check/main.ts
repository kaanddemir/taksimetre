/**
 * CLI for the "Check Taxi Tariffs" workflow (also runnable locally: npm run tariff:check).
 *   --out <dir>      report directory (default tariff-report)
 *   --index <url>    tariff index page (default TUHİM "Ücret Tarifeleri")
 *   --pdf <url>      skip discovery and check this document
 * Writes report.md, report.json, text.txt and source.pdf; appends the summary to
 * $GITHUB_STEP_SUMMARY when set. Exit code: 0 UP TO DATE, 1 CHANGES FOUND, 2 UNABLE TO VERIFY.
 * Read-only: never edits the registry or any source file.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ISTANBUL_TARIFFS } from "../../src/tariff/istanbul.ts";
import { exitCode, renderMarkdown, runCheck, toJson } from "./check.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1]?.trim() : undefined;
  return v ? v : undefined;
}

const out = arg("out") ?? "tariff-report";
const indexUrl = arg("index");
const pdfUrl = arg("pdf");

const report = await runCheck({
  fetch: (url, init) => fetch(url, init),
  registry: ISTANBUL_TARIFFS,
  now: new Date(),
  ...(indexUrl && { indexUrl }),
  ...(pdfUrl && { pdfUrl }),
});

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "report.md"), renderMarkdown(report, true));
writeFileSync(join(out, "report.json"), toJson(report));
writeFileSync(join(out, "text.txt"), report.text.join("\n") + "\n");
if (report.pdf) writeFileSync(join(out, "source.pdf"), report.pdf);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report, false) + "\n");
// Never echo remote text or user-supplied URLs into workflow-command-aware stdout.
console.log(report.status);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${report.status}\n`);
process.exit(exitCode(report.status));
