import { describe, expect, it } from "vitest";
import { syntheticMeasurement, SCENARIOS } from "../src/dev/scenarios.ts";
import { ISTANBUL_TARIFFS } from "../src/tariff/istanbul.ts";
import { ManualClock } from "../src/ui/clock.ts";
import { ledDuration, ledKm, textMoney } from "../src/ui/format.ts";
import { parseLed } from "../src/ui/led.ts";
import { FINISH_CONFIRM_MS, MeterStore } from "../src/ui/store.ts";
import { viewModel } from "../src/ui/view-model.ts";
import { STRINGS } from "../src/ui/i18n.ts";
import { readMeter } from "../src/engine/fare.ts";

function setup(today = "2026-10-30") {
  const clock = new ManualClock(1_000);
  const store = new MeterStore(clock, ISTANBUL_TARIFFS, () => today);
  const vm = (live = true) => viewModel(store.get(), clock.now(), "tr", live, (c) => store.tariffFor(c));
  const drive = (ms: number, kmh: number) => {
    clock.advance(ms);
    expect(store.measure({ atMs: clock.now(), distanceMm: Math.round((kmh / 3.6) * ms), speedKmh: kmh })).toBe(true);
  };
  const finish = () => {
    store.requestFinish();
    return store.requestFinish();
  };
  return { clock, store, vm, drive, finish };
}

describe("UI ↔ engine integration (store + view model)", () => {
  it("idle shows no fare and SERBEST only", () => {
    const { vm } = setup();
    const v = vm();
    expect(v.fareLed).toBe("");
    expect(v.legends).toEqual({ serbest: true, seyir: false, bekleme: false, ucret: false });
    expect(v.primary).toMatchObject({ action: "start", enabled: true });
  });

  it("starting shows the engine's opening fare, with no charging mode yet", () => {
    const { store, vm } = setup();
    expect(store.start()).toBe(true);
    expect(vm().fareLed).toBe("71.94");
    expect(vm().legends).toEqual({ serbest: false, seyir: false, bekleme: false, ucret: false });
  });

  it("movement updates fare and lights SEYİR; waiting lights BEKLEME", () => {
    const { store, vm, drive } = setup();
    store.start();
    drive(60_000, 60); // 1 km
    expect(vm().fareLed).toBe("119.94");
    expect(vm().legends.seyir).toBe(true);
    expect(vm().kmLed).toBe("1.00");
    drive(120_000, 0);
    expect(vm().fareLed).toBe("139.90");
    expect(vm().legends).toMatchObject({ seyir: false, bekleme: true });
    expect(vm().timeLed).toBe("0:03:00");
  });

  it("shows physical distance, including distance travelled while time-charging", () => {
    const { store, vm, drive } = setup();
    store.start();
    drive(120_000, 6); // 200 m slow
    expect(vm().kmLed).toBe("0.20");
    expect(vm().fareLed).toBe("91.90"); // 2 time steps, no distance steps
  });

  it("finish needs two taps; payable applies the minimum and explains it", () => {
    const { store, vm, drive } = setup();
    store.start();
    drive(60_000, 60);
    expect(store.requestFinish()).toBe(false);
    expect(vm()).toMatchObject({ status: "MESGUL", primary: { armed: true } });
    expect(store.requestFinish()).toBe(true);
    const v = vm();
    expect(v.status).toBe("UCRET");
    expect(v.fareLed).toBe("230.00");
    expect(v.notice).toEqual({ kind: "none" }); // minimum fare is not explained on the meter face
    expect(v.fareText).toContain("119,94 ₺");
    expect(v.fareText).toContain("230,00 ₺");
  });

  it("fare label is TOPLAM ÜCRET in every state", () => {
    const { store, vm, drive, finish } = setup();
    expect(vm()).toMatchObject({ status: "SERBEST", fareLabel: "TOPLAM ÜCRET" });
    store.start();
    drive(60_000, 60);
    expect(vm()).toMatchObject({ status: "MESGUL", fareLabel: "TOPLAM ÜCRET" });
    finish();
    expect(vm()).toMatchObject({ status: "UCRET", fareLabel: "TOPLAM ÜCRET" });
  });

  it("no minimum note when the fare is above the minimum", () => {
    const { store, vm, drive, finish } = setup();
    store.start();
    drive(600_000, 60);
    finish();
    expect(vm().fareLed).toBe("551.94");
    expect(vm().fareText).not.toMatch(/asgari/i);
  });

  it("arming expires", () => {
    const { store, clock, vm } = setup();
    store.start();
    store.requestFinish();
    clock.advance(FINISH_CONFIRM_MS + 1);
    store.expireArm();
    expect(vm().primary.armed).toBe(false);
    expect(store.requestFinish()).toBe(false); // re-arms instead of finishing
    expect(store.get().meter.status).toBe("MESGUL");
  });

  it("finalization freezes the fare; measurements are rejected", () => {
    const { store, clock, vm, drive, finish } = setup();
    store.start();
    drive(60_000, 60);
    finish();
    const before = vm().fareLed;
    clock.advance(60_000);
    expect(store.measure({ atMs: clock.now(), distanceMm: 1_000_000, speedKmh: 60 })).toBe(false);
    expect(vm().fareLed).toBe(before);
  });

  it("duplicate start does not double-charge", () => {
    const { store, vm } = setup();
    store.start();
    expect(store.start()).toBe(false);
    expect(store.get().lastError).toBe("INVALID_TRANSITION");
    expect(vm().fareLed).toBe("71.94");
  });

  it("clear is disabled until the 10 s display time, then returns to idle", () => {
    const { store, clock, vm, finish } = setup();
    store.start();
    finish();
    expect(vm().primary).toMatchObject({ action: "clear", enabled: false });
    expect(store.clear()).toBe(false);
    clock.advance(10_000);
    expect(vm().primary.enabled).toBe(true);
    expect(store.clear()).toBe(true);
    expect(vm().status).toBe("SERBEST");
  });

  it("resume keeps the fare and adds no second opening fare or paused time", () => {
    const { store, clock, vm, drive, finish } = setup();
    store.start();
    drive(600_000, 60);
    finish();
    clock.advance(300_000);
    expect(store.resume()).toBe(true);
    expect(vm().fareLed).toBe("551.94");
    drive(60_000, 0);
    expect(vm().fareLed).toBe("561.92");
  });

  it("tariff selection affects only the next journey", () => {
    const { store, vm, finish, clock } = setup();
    store.cycleCategory();
    expect(vm()).toMatchObject({ tariffDigit: "2", categoryName: "Turkuaz · D segment" });
    store.start();
    expect(vm().fareLed).toBe("82.73");
    expect(store.cycleCategory()).toBe(false);
    expect(vm().secondary.enabled).toBe(false);
    expect(vm().tariffDigit).toBe("2");
    finish();
    clock.advance(10_000);
    store.clear();
    store.cycleCategory();
    store.start();
    expect(vm().fareLed).toBe("93.52");
  });

  it("a browser without geolocation cannot start and says so", () => {
    const { vm } = setup();
    const v = vm(false);
    expect(v.primary.enabled).toBe(false);
    expect(v.notice).toMatchObject({ kind: "warn", text: "Konum desteklenmiyor" });
  });

  it("no tariff is a warning with details", () => {
    const { vm } = setup("2026-07-19");
    expect(vm().notice).toEqual({ kind: "warn", text: "Tarife yok" });
  });

  it("no tariff in force before 2026-07-20", () => {
    const { store, vm } = setup("2026-07-19");
    expect(vm().primary.enabled).toBe(false);
    expect(store.start()).toBe(false);
    expect(store.get().lastError).toBe("NO_TARIFF");
  });
});

describe("notice (single warning slot)", () => {
  it("every GPS phase maps to one short label; live/off show nothing", () => {
    const { store, vm, drive } = setup();
    store.start();
    drive(10_000, 30);
    const want: Record<string, string | null> = {
      off: null, live: null, acquiring: "Konum alınıyor…", weak: "GPS zayıf", interrupted: "GPS kesildi",
      stopped: "GPS kesildi", denied: "Konum izni gerekli", unavailable: "Konum alınamadı", timeout: "Konum alınamadı",
      unsupported: "Konum desteklenmiyor",
    };
    for (const [phase, text] of Object.entries(want)) {
      store.setGps(phase as never);
      const n = vm().notice;
      if (text === null) expect(n, phase).toEqual({ kind: "none" });
      else expect("text" in n && n.text, phase).toBe(text);
      if (phase === "acquiring") expect(n.kind).toBe("info");
      else if (text) expect(n.kind, phase).toBe("warn");
    }
  });

  it("finish confirmation and reset countdown stay off the face but reach screen readers", () => {
    const { store, vm, drive, finish } = setup();
    store.start();
    drive(60_000, 60);
    store.requestFinish();
    expect(vm()).toMatchObject({ notice: { kind: "none" }, primary: { label: "ONAYLA", ariaLabel: "Bitirmek için tekrar dokunun" } });
    finish();
    expect(vm()).toMatchObject({ notice: { kind: "none" }, primary: { enabled: false, ariaLabel: expect.stringMatching(/^SERBEST, \d+ sn sonra kullanılabilir$/) } });
  });

  it("past interruptions are not shown, but the engine still records them", () => {
    const { clock, store, vm, drive, finish } = setup();
    store.start();
    drive(10_000, 30);
    store.setGps("interrupted");
    expect(vm().notice).toEqual({ kind: "warn", text: "GPS kesildi" });
    clock.advance(53_000);
    store.gap(clock.now());
    store.setGps("live");
    expect(vm().notice).toEqual({ kind: "none" }); // warning disappears once the problem is resolved
    finish();
    expect(vm().notice).toEqual({ kind: "none" });
    const f = readMeter(store.get().meter);
    expect(f.gapCount).toBe(1);
    expect(f.unknownDurationMs).toBe(53_000);
  });

  it("no warning text contains counts, durations or explanations", () => {
    for (const lang of ["tr", "en"] as const) {
      for (const w of Object.values(STRINGS[lang].warn) as string[]) {
        expect(w.length, w).toBeLessThanOrEqual(24);
        expect(w).not.toMatch(/\d|\./);
      }
    }
  });

  it("English labels are short too", () => {
    const { store } = setup();
    store.setGps("interrupted");
    const n = viewModel(store.get(), 0, "en", true, (c) => store.tariffFor(c)).notice;
    expect(n).toMatchObject({ kind: "warn", text: "GPS lost" });
  });
});

describe("formatting", () => {
  it("money, distance and duration", () => {
    expect(textMoney(55_194)).toBe("551,94 ₺");
    expect(ledKm(1_234_567)).toBe("1.23");
    expect(ledKm(0)).toBe("0.00");
    expect(ledDuration(3_725_000)).toBe("1:02:05");
  });
});

describe("LED parsing", () => {
  it("attaches decimal points and pads", () => {
    const cells = parseLed("71.94", 6);
    expect(cells).toHaveLength(6);
    expect(cells.map((c) => c.char).join("")).toBe("  7194");
    expect(cells[3]!.dot).toBe(true);
  });
  it("grows beyond the minimum instead of clipping", () => {
    expect(parseLed("14471.94", 6).filter((c) => c.kind === "digit")).toHaveLength(7);
  });
  it("supports colons and blanks", () => {
    expect(parseLed("0:03:00", 5).filter((c) => c.kind === "colon")).toHaveLength(2);
    expect(parseLed("", 6).every((c) => c.char === " ")).toBe(true);
  });
  it("rejects unsupported glyphs", () => {
    expect(() => parseLed("12a", 3)).toThrow();
  });
});

describe("dev scenarios", () => {
  it("produce valid normalized measurements", () => {
    for (const s of SCENARIOS) {
      const m = syntheticMeasurement(s, 0, 0, 1_000)!;
      expect(Number.isSafeInteger(m.distanceMm)).toBe(true);
      expect(m.speedKmh).toBeGreaterThanOrEqual(0);
    }
    expect(syntheticMeasurement(SCENARIOS[0]!, 0, 1_000, 1_000)).toBeNull();
  });
});
