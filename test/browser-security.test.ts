import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("static-host browser protections", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  it("authorizes the exact pre-paint theme bootstrap without general inline-script permissions", () => {
    const bootstrap = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const hash = createHash("sha256").update(bootstrap).digest("base64");
    expect(html).toContain(`'sha256-${hash}'`);
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    for (const directive of ["default-src 'none'", "connect-src 'self'", "worker-src 'self'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) expect(policy).toContain(directive);
    expect(html.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(html.indexOf("<script>"));
  });

  it("does not pretend HTTP-only policies are enforced by meta tags", () => {
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).not.toMatch(/http-equiv="(?:X-Frame-Options|Permissions-Policy)"|frame-ancestors/);
  });
});
