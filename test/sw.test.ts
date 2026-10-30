import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const template = readFileSync(new URL("../src/pwa/sw.js", import.meta.url), "utf8");
function worker(scope: string, cacheNames = new Set<string>()) {
  const handlers: Record<string, (e: any) => void> = {};
  const windows = [{ id: "a", url: scope }];
  let activations = 0;
  const ctx = createContext({ VERSION: "0123456789ab", ASSETS: [],
    self: { registration: { scope }, location: { origin: new URL(scope).origin },
      addEventListener: (type: string, fn: (e: any) => void) => handlers[type] = fn,
      skipWaiting: async () => { activations++; },
      clients: { matchAll: async () => windows, claim: async () => {} } },
    caches: { keys: async () => [...cacheNames], delete: async (key: string) => cacheNames.delete(key) },
  });
  runInContext(template, ctx);
  const prefix = runInContext("PREFIX", ctx) as string;
  const cache = runInContext("CACHE", ctx) as string;
  const send = async (type: string, data: unknown = undefined, id = "a") => {
    const pending: Promise<unknown>[] = [];
    handlers[type]!({ data, source: { id }, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  };
  return { windows, cache, prefix, send, get activations() { return activations; } };
}

describe("service-worker isolation and update guard", () => {
  it("separates deployment scopes and only deletes obsolete caches in its own namespace", async () => {
    const keys = new Set<string>();
    const a = worker("https://example.test/a/", keys);
    const b = worker("https://example.test/b/", keys);
    expect(a.cache).not.toBe(b.cache);
    for (const key of [a.cache, a.prefix + "old", b.cache, b.prefix + "old", "taksimetre-legacy", "other-app"]) keys.add(key);
    await a.send("activate");
    expect([...keys]).toEqual([a.cache, b.cache, b.prefix + "old", "taksimetre-legacy", "other-app"]);
    expect(worker("https://example.test/a/").cache).toBe(a.cache);
  });

  it("refuses takeover while a second scoped window exists, and recovers after it closes", async () => {
    const w = worker("https://example.test/a/");
    w.windows.push({ id: "b", url: "https://example.test/a/?diag" });
    await w.send("message", "skip-waiting");
    expect(w.activations).toBe(0);
    w.windows.pop();
    await w.send("message", "skip-waiting");
    expect(w.activations).toBe(1);
  });

  it("ignores sibling deployments and refuses messages from an unrelated client", async () => {
    const w = worker("https://example.test/a/");
    w.windows.push({ id: "b", url: "https://example.test/ab/" });
    await w.send("message", "skip-waiting", "b");
    expect(w.activations).toBe(0);
    await w.send("message", "skip-waiting");
    expect(w.activations).toBe(1);
  });
});
