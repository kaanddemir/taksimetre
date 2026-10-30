/**
 * Service worker registration and the safe update rule.
 *
 * A new version is downloaded in the background and then waits. It is activated, and this page
 * reloaded onto it, only when BOTH hold:
 *   - the meter is idle (SERBEST, not acquiring GPS): never during a journey or while a final
 *     fare is on screen;
 *   - the page is hidden (app switched away, screen locked): the reload is never seen.
 * The worker additionally refuses forced activation while another in-scope window exists.
 * A hidden idle page retries after other windows close. Otherwise the browser's own rule applies: the new version takes over once every tab of the old
 * one is closed, e.g. the next cold start. No prompt, no permanent UI.
 */

/** The parts of the Service Worker API used here (real objects in the app, fakes in tests). */
export interface SwWorker {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", fn: () => void): void;
}
export interface SwRegistration {
  readonly waiting: SwWorker | null;
  readonly installing: SwWorker | null;
  update(): Promise<unknown>;
  addEventListener(type: "updatefound", fn: () => void): void;
}
export interface SwContainer {
  readonly controller: unknown;
  register(url: string): Promise<SwRegistration>;
  addEventListener(type: "controllerchange", fn: () => void): void;
}

export interface UpdateDeps {
  sw: SwContainer;
  url: string;
  /** True when no journey is active or starting. */
  isIdle: () => boolean;
  onIdleChange: (fn: () => void) => void;
  isHidden: () => boolean;
  onVisibilityChange: (fn: () => void) => void;
  reload: () => void;
  now: () => number;
  /** Minimum time between update checks when the app comes back to the foreground. */
  checkEveryMs?: number;
}

const CHECK_EVERY_MS = 60 * 60 * 1000;

export async function startUpdates(d: UpdateDeps): Promise<SwRegistration | null> {
  let controlled = d.sw.controller != null;
  let stale = false; // a newer version now controls this page, whose code is older
  let reloading = false;
  let reg: SwRegistration | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let lastCheck = d.now();

  function apply(): void {
    if (retry !== null) { clearTimeout(retry); retry = null; }
    if (reloading || !d.isIdle() || !d.isHidden()) return;
    if (stale) {
      reloading = true;
      d.reload();
    } else if (reg?.waiting) {
      reg.waiting.postMessage("skip-waiting");
      // The worker refuses while other windows exist. Retry so closing a second
      // window cannot leave the remaining hidden, idle window waiting forever.
      retry = setTimeout(apply, 5_000);
    }
  }

  d.sw.addEventListener("controllerchange", () => {
    // First install (no previous controller) only claims the page: same code, nothing to reload.
    if (controlled) stale = true;
    controlled = true;
    apply();
  });
  d.onIdleChange(apply);
  d.onVisibilityChange(() => {
    if (!d.isHidden() && d.now() - lastCheck >= (d.checkEveryMs ?? CHECK_EVERY_MS)) {
      lastCheck = d.now();
      void reg?.update().catch(() => undefined); // offline or server error: try again next time
    }
    apply();
  });

  try {
    reg = await d.sw.register(d.url);
  } catch {
    return null; // e.g. private mode or blocked storage: the app still works online
  }
  const r = reg;
  r.addEventListener("updatefound", () => {
    const w = r.installing;
    w?.addEventListener("statechange", () => w.state === "installed" && apply());
  });
  apply();
  return r;
}

/** Build id of the version serving this page (shown in the info panel), or null without a service worker. */
export function activeVersion(container: { controller: { postMessage(m: unknown, t: Transferable[]): void } | null } | undefined): Promise<string | null> {
  const c = container?.controller;
  if (!c) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1_000);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(typeof e.data === "string" ? e.data.slice(0, 8) : null);
    };
    c.postMessage("version", [ch.port2]);
  });
}
