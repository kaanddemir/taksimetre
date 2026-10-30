import "./styles.css";
import { version as appVersion } from "../package.json";
import { LiveJourney } from "./gps/live.ts";
import type { GeoApi } from "./gps/tracker.ts";
import type { WakeLockApi } from "./gps/wake-lock.ts";
import { createSaver, restore, STORAGE_KEY, type KeyValueStore } from "./journey/persist.ts";
import { startUpdates } from "./pwa/register.ts";
import { ISTANBUL_TARIFFS } from "./tariff/istanbul.ts";
import { istanbulDate } from "./tariff/select.ts";
import { TARIFF_CATEGORIES, type TariffCategory } from "./tariff/types.ts";
import { mountApp } from "./ui/app.ts";
import { realClock, ScaledClock, type Clock } from "./ui/clock.ts";
import type { Lang } from "./ui/i18n.ts";
import { MeterStore } from "./ui/store.ts";
import { initTheme } from "./ui/theme.ts";

// Defense in depth on static hosts: do not mount an interactive meter in a frame.
// A host-supplied frame-ancestors header is still required to block embedding itself.
if (window.top !== window.self) throw new Error("Taksimetre cannot run in a frame");

/** Dev builds can replace GPS with the simulator via ?sim. Production always uses GPS. */
const SIM = import.meta.env.DEV && new URLSearchParams(location.search).has("sim");

// Preferences only (language, category, theme). Storage can be blocked (privacy settings): then defaults apply.
const prefs = safePrefs();
const savedLang = prefs.getItem("lang");
const lang: Lang = savedLang === "en" ? "en" : "tr";
document.documentElement.lang = lang;
initTheme();
const savedCat = prefs.getItem("category") as TariffCategory | null;
const category = savedCat && TARIFF_CATEGORIES.includes(savedCat) ? savedCat : "yellow-c";

const clock: Clock = SIM ? new ScaledClock() : realClock;
const store = new MeterStore(clock, ISTANBUL_TARIFFS, () => istanbulDate(Date.now()), category);
store.subscribe((s) => prefs.setItem("category", s.category));

// ---- Journey recovery (sessionStorage, meter state only, no coordinates) ----
const storage = safeSessionStorage();
let restoredUnknownMs = 0;
if (!SIM && storage) {
  const r = restore(storage.getItem(STORAGE_KEY), ISTANBUL_TARIFFS, clock.now(), Date.now());
  if (r.ok && store.restore(r.meter)) restoredUnknownMs = r.unknownMs;
  else storage.removeItem(STORAGE_KEY); // empty, corrupt, old schema, unknown tariff or expired
}
if (restoredUnknownMs > 0) store.gap(clock.now()); // page was gone: recorded as an interruption, not charged

const saver = storage && !SIM ? createSaver(storage, () => clock.now(), Date.now) : null;
const save = (force = false) => saver?.(store.get().meter, force);
store.subscribe(() => save());
document.addEventListener("visibilitychange", () => document.hidden && save(true));
addEventListener("pagehide", () => save(true));

// ---- Live GPS ----
const geo: GeoApi | null = "geolocation" in navigator && window.isSecureContext ? navigator.geolocation : null;
const live = SIM
  ? null
  : new LiveJourney({
      store,
      clock,
      geo,
      wakeLock: ("wakeLock" in navigator ? (navigator.wakeLock as unknown as WakeLockApi) : null),
      isHidden: () => document.hidden,
      onVisibilityChange: (fn) => {
        document.addEventListener("visibilitychange", fn);
        return () => document.removeEventListener("visibilitychange", fn);
      },
      permissionGranted: async () => (await navigator.permissions?.query({ name: "geolocation" }))?.state === "granted",
    });

const root = document.getElementById("app")!;
mountApp(root, store, {
  liveAvailable: SIM || (live?.supported ?? false),
  lang,
  onLangChange: (l) => prefs.setItem("lang", l),
  version: () => Promise.resolve(appVersion),
  ...(live && {
    actions: {
      start: () => live.start(),
      resume: () => live.resume(),
      cancel: () => live.cancel(),
      reconnect: () => live.reconnect(),
    },
  }),
});
if (live) void live.afterRestore();

// ?diag: field-validation readout (aggregate GPS quality + journey record, never coordinates).
if (live && new URLSearchParams(location.search).has("diag")) {
  void import("./ui/diag.ts").then((m) => m.mountDiag(store, live));
}

// ---- Offline app shell + safe updates (production builds only; see src/pwa/register.ts) ----
if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
  const isIdle = () => store.get().meter.status === "SERBEST" && store.get().gps !== "acquiring";
  void startUpdates({
    sw: navigator.serviceWorker,
    url: "./sw.js",
    isIdle,
    onIdleChange: (fn) => void store.subscribe(fn),
    isHidden: () => document.hidden,
    onVisibilityChange: (fn) => document.addEventListener("visibilitychange", fn),
    reload: () => location.reload(),
    now: Date.now,
  });
}

if (SIM) {
  void import("./dev/simulator.ts").then((m) => m.mountSimulator(store, clock as ScaledClock));
}

function safeSessionStorage(): KeyValueStore | null {
  try {
    const storage = window.sessionStorage;
    return {
      getItem: (key) => { try { return storage.getItem(key); } catch { return null; } },
      setItem: (key, value) => { try { storage.setItem(key, value); } catch { /* recovery is best effort */ } },
      removeItem: (key) => { try { storage.removeItem(key); } catch { /* blocked storage */ } },
    };
  } catch {
    return null;
  }
}

/** localStorage for preferences; reads and writes that throw (blocked, quota) fall back to defaults. */
function safePrefs(): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* preference lasts for this page only */
      }
    },
  };
}
