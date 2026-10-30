import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

/** Enforce policies in a real browser: DOM injection here deliberately bypasses app code. */
test("production CSP permits only the hashed theme bootstrap and same-origin application resources", async ({ page, context, request }) => {
  const violations: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    (window as any).__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as any).__violations.push(e.effectiveDirective));
  });
  await context.route("**/csp-eval-probe.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: 'try { window.eval("window.__evalRan = true"); } catch { window.__evalBlocked = true; }',
  }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "BAŞLAT" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to English" }).click();
  await page.locator("button.theme").click();
  await page.goto("/?diag");
  await expect(page.locator(".diag")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__violations)).toEqual([]);
  expect(errors).toEqual([]);

  const html = await (await request.get("/")).text();
  const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
  expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|nonce-|ws:|wss:/);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (!script[1]!.trim()) continue;
    const hash = createHash("sha256").update(script[1]!).digest("base64");
    expect(policy).toContain(`'sha256-${hash}'`);
  }
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");

  let referrer: string | undefined;
  await context.route("**/referrer-probe", (route) => {
    referrer = route.request().headers()["referer"];
    return route.fulfill({ body: "ok" });
  });
  expect(await page.evaluate(async () => (await fetch("/referrer-probe")).text())).toBe("ok");
  expect(referrer).toBeUndefined();

  let externalRequests = 0;
  await context.route("https://security-probe.invalid/**", (route) => { externalRequests++; return route.fulfill({ body: "" }); });
  await page.evaluate(async () => {
    const s = document.createElement("script"); s.textContent = "window.__inlineRan = true"; document.head.append(s);
    const remote = document.createElement("script"); remote.src = "https://security-probe.invalid/script.js"; document.head.append(remote);
    const style = document.createElement("style"); style.textContent = "body { background: rgb(1, 2, 3) !important }"; document.head.append(style);
    const image = document.createElement("img"); image.src = "https://security-probe.invalid/image.png"; document.body.append(image);
    const frame = document.createElement("iframe"); frame.src = "https://security-probe.invalid/frame"; document.body.append(frame);
    const object = document.createElement("object"); object.data = "https://security-probe.invalid/object"; document.body.append(object);
    const base = document.createElement("base"); base.href = "https://security-probe.invalid/"; document.head.append(base);
    await fetch("https://security-probe.invalid/leak").catch(() => {});
    const form = document.createElement("form"); form.action = "https://security-probe.invalid/form";
    document.body.append(form); form.requestSubmit();
    const evalProbe = document.createElement("script"); evalProbe.src = "/csp-eval-probe.js"; document.head.append(evalProbe);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__evalBlocked)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__violations.length)).toBeGreaterThanOrEqual(10);
  violations.push(...await page.evaluate(() => (window as any).__violations as string[]));
  expect(violations).toEqual(expect.arrayContaining(["script-src-elem", "style-src-elem", "img-src", "frame-src", "object-src", "base-uri", "connect-src", "script-src", "form-action"]));
  expect(externalRequests).toBe(0);
  expect(await page.evaluate(() => [(window as any).__inlineRan, (window as any).__evalRan])).toEqual([undefined, undefined]);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(1, 2, 3)");
});

test("an embedded page never mounts the interactive meter", async ({ page }) => {
  await page.route("**/frame-host", (route) => route.fulfill({ contentType: "text/html", body: '<iframe src="/"></iframe>' }));
  await page.goto("/frame-host");
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("main#app")).toBeAttached();
  await expect(frame.getByRole("button", { name: "BAŞLAT" })).toHaveCount(0);
});
