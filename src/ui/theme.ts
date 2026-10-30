export type Theme = "dark" | "light";
export type ThemePref = Theme | "system";
/** Tap order of the toggle: System → Light → Dark → System. */
export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"];
export const nextPref = (p: ThemePref): ThemePref => THEME_PREFS[(THEME_PREFS.indexOf(p) + 1) % THEME_PREFS.length]!;

const KEY = "theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** Anything other than a saved "light"/"dark" means System; System is dark unless the device says light. */
export function parsePref(saved: string | null): ThemePref {
  return saved === "light" || saved === "dark" ? saved : "system";
}
export function resolveTheme(pref: ThemePref, systemLight: boolean): Theme {
  return pref === "system" ? (systemLight ? "light" : "dark") : pref;
}

let pref: ThemePref = "system";
const mq = (): MediaQueryList | undefined => window.matchMedia?.(LIGHT_QUERY);

export const themePref = (): ThemePref => pref;
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function apply(): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(pref, mq()?.matches ?? false);
  const surface = getComputedStyle(root).getPropertyValue("--surface").trim();
  if (surface) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", surface);
}

/** Applies the saved preference and keeps System in step with the device appearance. */
export function initTheme(): void {
  try {
    pref = parsePref(localStorage.getItem(KEY));
  } catch {
    pref = "system";
  }
  apply();
  mq()?.addEventListener?.("change", () => pref === "system" && apply());
}

export function setThemePref(next: ThemePref): void {
  pref = next;
  apply();
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}
