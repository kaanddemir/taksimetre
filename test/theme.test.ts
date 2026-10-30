import { describe, expect, it } from "vitest";
import { STRINGS } from "../src/ui/i18n.ts";
import { nextPref, parsePref, resolveTheme } from "../src/ui/theme.ts";

describe("theme", () => {
  it("System is the default; only saved light/dark override it", () => {
    expect(parsePref(null)).toBe("system");
    expect(parsePref("garbage")).toBe("system");
    expect(parsePref("system")).toBe("system");
    expect(parsePref("light")).toBe("light");
    expect(parsePref("dark")).toBe("dark");
  });
  it("System follows the device, dark unless it says light; manual choices ignore the device", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });
  it("toggle cycles System → Light → Dark → System", () => {
    expect(nextPref("system")).toBe("light");
    expect(nextPref("light")).toBe("dark");
    expect(nextPref("dark")).toBe("system");
  });
  it("label announces the current preference and the next one", () => {
    expect(STRINGS.tr.themeLabel("Sistem", "Açık")).toBe("Tema: Sistem. Dokununca: Açık");
    expect(STRINGS.en.themeLabel("Dark", "System")).toBe("Theme: Dark. Tap for System");
  });
  it("exactly three option names in both languages", () => {
    expect(STRINGS.tr.themeNames).toEqual({ light: "Açık", dark: "Koyu", system: "Sistem" });
    expect(STRINGS.en.themeNames).toEqual({ light: "Light", dark: "Dark", system: "System" });
  });
});
