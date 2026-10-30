import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Structural checks of the GitHub Actions workflows (no YAML dependency: line-based, comments removed). */
const root = new URL("../", import.meta.url);
const load = (f: string) =>
  readFileSync(new URL(`.github/workflows/${f}`, root), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { scripts: Record<string, string> };

/** The text of one top-level job block. */
const job = (yml: string, name: string) => {
  const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|$)`).exec(yml);
  if (!m) throw new Error(`job ${name} not found`);
  return m[1]!;
};
const uses = (yml: string) => [...yml.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);

describe("Check Taxi Tariffs workflow", () => {
  const yml = load("check-tariffs.yml");

  it("is named as required and runs only on manual dispatch", () => {
    expect(yml).toMatch(/^name: Check Taxi Tariffs$/m);
    const on = /\non:\n([\s\S]*?)\n\S/.exec(yml)![1]!;
    expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(["  workflow_dispatch:"]);
  });

  it("is read-only and cannot change the repository or deploy", () => {
    expect(yml).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(yml).not.toMatch(/: write/);
    expect(yml).not.toMatch(/git (push|commit)|gh pr|create-pull-request|deploy-pages|upload-pages-artifact/);
    expect(yml).toContain("persist-credentials: false");
  });

  it("passes the manual input through the environment (no script injection)", () => {
    const runBlocks = [...yml.matchAll(/run: \|\n((?: {10}.*\n?)+)/g)].map((m) => m[1]!);
    expect(runBlocks.length).toBeGreaterThan(0);
    for (const r of runBlocks) expect(r).not.toContain("${{");
  });

  it("runs the existing checker and always uploads the report", () => {
    expect(yml).toContain("scripts/tariff-check/main.ts");
    expect(existsSync(new URL("scripts/tariff-check/main.ts", root))).toBe(true);
    expect(yml).toMatch(/if: always\(\)\n\s+uses: actions\/upload-artifact@[0-9a-f]{40}/);
    expect(uses(yml).every((u) => u.startsWith("actions/"))).toBe(true);
  });
});

describe("Build & Deploy workflow", () => {
  const yml = load("deploy.yml");
  const verify = job(yml, "verify");
  const deploy = job(yml, "deploy");

  it("runs only on manual dispatch", () => {
    const on = /\non:\n([\s\S]*?)\n\S/.exec(yml)![1]!;
    expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(["  workflow_dispatch:"]);
  });

  it("defaults to read-only; only the deploy job may write to Pages", () => {
    expect(yml).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(verify).not.toMatch(/permissions:/);
    expect(deploy).toMatch(/permissions:\n\s+pages: write\n\s+id-token: write/);
  });

  it("runs every check before building the artifact, in order", () => {
    const order = ["npm ci", "npm run typecheck", "npm test", "npx playwright install", "npm run e2e", "npm run build", "upload-pages-artifact"];
    const idx = order.map((s) => verify.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    for (const s of ["typecheck", "test", "e2e", "build"]) expect(pkg.scripts[s], s).toBeTruthy();
  });

  it("deploys only after the checks pass, from main, and only when explicitly enabled", () => {
    expect(deploy).toMatch(/needs: verify/);
    const gate = "github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && vars.PAGES_DEPLOY_ENABLED == 'true'";
    expect(deploy).toContain(`if: ${gate}`);
    expect(verify).toContain(`if: ${gate}`); // no artifact is uploaded when deployment is off
    expect(deploy).toMatch(/uses: actions\/deploy-pages@[0-9a-f]{40}/);
    expect(deploy).toMatch(/name: github-pages/);
  });

  it("assumes no domain or repository name", () => {
    expect(yml).not.toMatch(/github\.io|CNAME|cname|base_path|--base/);
    expect(readFileSync(new URL("vite.config.ts", root), "utf8")).toMatch(/base: "\.\/"/);
    expect(existsSync(new URL("public/CNAME", root))).toBe(false);
  });

  it("uses official actions only", () => {
    expect(uses(yml).length).toBeGreaterThan(0);
    expect(uses(yml).every((u) => /^actions\/[a-z-]+@[0-9a-f]{40}$/.test(u))).toBe(true);
  });
});


describe("immutable action dependencies", () => {
  it("pins every action to a full SHA and retains least privilege and safe inputs", () => {
    for (const file of ["deploy.yml", "check-tariffs.yml"]) {
      const yml = load(file);
      for (const action of uses(yml)) expect(action).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
      expect(yml).not.toMatch(/pull_request_target|secrets\./);
    }
    const tariff = load("check-tariffs.yml");
    expect(tariff).toContain('args+=(--pdf "$PDF_URL")');
    expect(tariff).toContain('"${args[@]}"');
    expect(tariff).toContain("package-manager-cache: false");
  });
});
