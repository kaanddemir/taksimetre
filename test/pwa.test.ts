import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUpdates, type SwContainer, type SwRegistration, type SwWorker } from "../src/pwa/register.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

class FakeWorker implements SwWorker {
  state = "installing";
  messages: unknown[] = [];
  private fns: (() => void)[] = [];
  postMessage(m: unknown) {
    this.messages.push(m);
  }
  addEventListener(_: "statechange", fn: () => void) {
    this.fns.push(fn);
  }
  setState(s: string) {
    this.state = s;
    this.fns.forEach((f) => f());
  }
}

function setup(opts: { controlled?: boolean; waiting?: boolean; registerFails?: boolean } = {}) {
  const env = { idle: true, hidden: false, now: 0, reloads: 0, updates: 0 };
  const listeners = { controller: [] as (() => void)[], idle: [] as (() => void)[], vis: [] as (() => void)[], found: [] as (() => void)[] };
  const reg = {
    waiting: opts.waiting ? new FakeWorker() : null,
    installing: null as FakeWorker | null,
    update: async () => void env.updates++,
    addEventListener: (_: "updatefound", fn: () => void) => void listeners.found.push(fn),
  } satisfies SwRegistration;
  const sw: SwContainer = {
    controller: opts.controlled === false ? null : {},
    register: async () => {
      if (opts.registerFails) throw new Error("blocked");
      return reg;
    },
    addEventListener: (_: "controllerchange", fn: () => void) => void listeners.controller.push(fn),
  };
  const started = startUpdates({
    sw,
    url: "./sw.js",
    isIdle: () => env.idle,
    onIdleChange: (fn) => void listeners.idle.push(fn),
    isHidden: () => env.hidden,
    onVisibilityChange: (fn) => void listeners.vis.push(fn),
    reload: () => void env.reloads++,
    now: () => env.now,
    checkEveryMs: 1000,
  });
  const fire = (k: keyof typeof listeners) => listeners[k].forEach((f) => f());
  /** New version downloaded and waiting. */
  const install = () => {
    const w = new FakeWorker();
    reg.installing = w;
    fire("found");
    reg.waiting = w;
    reg.installing = null;
    w.setState("installed");
    return w;
  };
  return { env, reg, fire, install, started };
}

describe("safe update lifecycle", () => {
  it("waits while the meter is busy, even when hidden", async () => {
    const t = setup();
    await t.started;
    t.env.idle = false; // journey running
    t.env.hidden = true; // screen locked
    const w = t.install();
    t.fire("vis");
    t.fire("idle");
    expect(w.messages).toEqual([]);
    expect(t.env.reloads).toBe(0);
  });

  it("waits while idle but on screen (no visible reload)", async () => {
    const t = setup();
    await t.started;
    const w = t.install();
    t.fire("idle");
    expect(w.messages).toEqual([]);
  });

  it("activates when idle and hidden, then reloads once onto the new version", async () => {
    const t = setup();
    await t.started;
    t.env.idle = false;
    const w = t.install();
    t.env.hidden = true;
    t.fire("vis");
    expect(w.messages).toEqual([]); // journey still running
    t.env.idle = true; // SERBEST
    t.fire("idle");
    expect(w.messages).toEqual(["skip-waiting"]);
    t.fire("controller");
    t.fire("idle");
    expect(t.env.reloads).toBe(1);
  });

  it("a takeover by another tab mid-journey defers the reload until idle and hidden", async () => {
    const t = setup();
    await t.started;
    t.env.idle = false;
    t.fire("controller"); // another tab activated the new version
    t.env.hidden = true;
    t.fire("vis");
    expect(t.env.reloads).toBe(0);
    t.env.idle = true;
    t.env.hidden = false;
    t.fire("idle");
    expect(t.env.reloads).toBe(0);
    t.env.hidden = true;
    t.fire("vis");
    expect(t.env.reloads).toBe(1);
  });

  it("first install only claims the page: no reload", async () => {
    const t = setup({ controlled: false });
    await t.started;
    t.env.hidden = true;
    t.fire("controller");
    t.fire("vis");
    expect(t.env.reloads).toBe(0);
  });

  it("a version already waiting at launch is applied at the next safe point", async () => {
    const t = setup({ waiting: true });
    await t.started;
    expect(t.reg.waiting!.messages).toEqual([]);
    t.env.hidden = true;
    t.fire("vis");
    expect((t.reg.waiting as FakeWorker).messages).toEqual(["skip-waiting"]);
  });

  it("checks for updates on return to the foreground, at most once per interval", async () => {
    const t = setup();
    await t.started;
    t.fire("vis");
    expect(t.env.updates).toBe(0);
    t.env.now = 1000;
    t.fire("vis");
    t.fire("vis");
    expect(t.env.updates).toBe(1);
    t.env.hidden = true;
    t.env.now = 5000;
    t.fire("vis"); // hidden: no network check
    expect(t.env.updates).toBe(1);
  });

  it("a failed registration leaves the app running", async () => {
    const t = setup({ registerFails: true });
    expect(await t.started).toBeNull();
  });
});


describe("deferred multi-window update requests", () => {
  it("retries while idle and hidden, then stops as soon as the meter is busy or visible", async () => {
    const t = setup({ waiting: true }); await t.started;
    t.env.hidden = true; t.fire("vis");
    vi.advanceTimersByTime(5_000);
    expect(t.reg.waiting!.messages).toEqual(["skip-waiting", "skip-waiting"]);
    t.env.idle = false; t.fire("idle");
    vi.advanceTimersByTime(20_000);
    expect(t.reg.waiting!.messages).toHaveLength(2);
    t.env.idle = true; t.env.hidden = false; t.fire("idle");
    vi.advanceTimersByTime(20_000);
    expect(t.reg.waiting!.messages).toHaveLength(2);
  });

  it("does not keep retrying after activation or after the waiting worker disappears", async () => {
    const t = setup({ waiting: true }); await t.started;
    t.env.hidden = true; t.fire("vis");
    const worker = t.reg.waiting!;
    t.reg.waiting = null;
    vi.advanceTimersByTime(20_000);
    expect(worker.messages).toHaveLength(1);
    t.fire("controller");
    vi.advanceTimersByTime(20_000);
    expect(t.env.reloads).toBe(1);
  });
});
