import { payable, readMeter } from "../engine/fare.ts";
import { TARIFF_CATEGORIES, type Tariff } from "../tariff/types.ts";
import { STRINGS, type Lang } from "./i18n.ts";
import { ledDuration, ledKm, ledMoney, textMoney } from "./format.ts";
import { FINISH_CONFIRM_MS, type AppState } from "./store.ts";

export interface ButtonVM {
  action: "category" | "start" | "finish" | "resume" | "clear" | "cancel" | "reconnect";
  label: string;
  enabled: boolean;
  armed: boolean;
  ariaLabel: string;
}

export interface ViewModel {
  status: "SERBEST" | "MESGUL" | "UCRET";
  fareLabel: string;
  /** LED text; "" means all segments unlit (idle). */
  fareLed: string;
  fareText: string;
  legends: { serbest: boolean; seyir: boolean; bekleme: boolean; ucret: boolean };
  tariffDigit: string;
  categoryName: string;
  kmLed: string;
  timeLed: string;
  tripText: string;
  /** One notice slot: nothing, a plain info line, or a warning whose details open on request. */
  notice: Notice;
  secondary: ButtonVM;
  primary: ButtonVM;
}

export type Notice = { kind: "none" } | { kind: "info"; text: string } | { kind: "warn"; text: string };

type WarnKey = keyof (typeof STRINGS)["tr"]["warn"];
const GPS_WARN: ReadonlySet<string> = new Set(["weak", "interrupted", "stopped", "denied", "unavailable", "timeout", "unsupported"]);

/**
 * Picks the single notice for the meter face: a short, real-time warning while a problem lasts,
 * "acquiring" as plain info, otherwise nothing. Past interruptions are not shown (the engine still records them).
 */
function notice(t: (typeof STRINGS)[Lang], gps: AppState["gps"], primary: WarnKey | null): Notice {
  const key: WarnKey | null = primary ?? (GPS_WARN.has(gps) ? (gps as WarnKey) : null);
  if (key !== null) return { kind: "warn", text: t.warn[key] };
  return gps === "acquiring" ? { kind: "info", text: t.acquiring } : { kind: "none" };
}

/**
 * Pure mapping from engine + UI state to what is drawn. All money comes from
 * readMeter / payable; this function only formats it.
 */
export function viewModel(
  s: AppState,
  now: number,
  lang: Lang,
  liveAvailable: boolean,
  tariffFor: (c: AppState["category"]) => Tariff | undefined,
): ViewModel {
  const t = STRINGS[lang];
  const m = s.meter;
  const r = readMeter(m);
  const category = m.status === "SERBEST" ? s.category : m.journey.tariff.category;
  const tariffDigit = String(TARIFF_CATEGORIES.indexOf(category) + 1);
  const kmLed = ledKm(r.totalDistanceMm);
  // Elapsed journey time includes intervals with unknown motion (they are shown, not charged).
  const timeLed = ledDuration(r.totalDurationMs + r.unknownDurationMs);
  const tripText = `${t.srDistance(kmLed.replace(".", ","))}. ${t.srDuration(timeLed)}`;
  const base = { tariffDigit, categoryName: t.category[category], kmLed, timeLed, tripText };
  const acquiring = s.gps === "acquiring";

  if (m.status === "SERBEST") {
    const available = tariffFor(s.category) !== undefined;
    const primary: WarnKey | null = s.lastError === "NO_TARIFF" || !available ? "noTariff" : !liveAvailable ? "unsupported" : null;
    return {
      ...base,
      status: "SERBEST",
      fareLabel: t.fareLabel,
      fareLed: "",
      fareText: t.srIdle,
      legends: { serbest: true, seyir: false, bekleme: false, ucret: false },
      notice: notice(t, s.gps, primary),
      secondary: acquiring
        ? { action: "cancel", label: t.cancel, enabled: true, armed: false, ariaLabel: t.cancel }
        : { action: "category", label: t.changeTariff, enabled: true, armed: false, ariaLabel: `${t.changeTariff}: ${t.category[category]}` },
      primary: acquiring
        ? { action: "start", label: t.acquiringKey, enabled: false, armed: false, ariaLabel: t.acquiring }
        : { action: "start", label: t.start, enabled: liveAvailable && available, armed: false, ariaLabel: t.start },
    };
  }

  if (m.status === "MESGUL") {
    const armed = s.finishArmedAt !== null && now - s.finishArmedAt <= FINISH_CONFIRM_MS;
    return {
      ...base,
      status: "MESGUL",
      fareLabel: t.fareLabel,
      fareLed: ledMoney(r.meterFareKurus),
      fareText: t.srFare(textMoney(r.meterFareKurus)),
      legends: { serbest: false, seyir: r.mode === "distance", bekleme: r.mode === "time", ucret: false },
      notice: notice(t, s.gps, null),
      secondary:
        s.gps === "stopped" || s.gps === "denied"
          ? { action: "reconnect", label: t.gpsKey, enabled: true, armed: false, ariaLabel: t.gpsKeyLabel }
          : { action: "category", label: t.changeTariff, enabled: false, armed: false, ariaLabel: `${t.changeTariff}: ${t.category[category]}` },
      primary: { action: "finish", label: armed ? t.finishConfirm : t.finish, enabled: true, armed, ariaLabel: armed ? t.armedHint : t.finish },
    };
  }

  const f = payable(m)!;
  const wait = m.journey.policy.minFareDisplayMs - (now - m.finalizedAtMs);
  return {
    ...base,
    status: "UCRET",
    fareLabel: t.fareLabel,
    fareLed: ledMoney(f.totalKurus),
    // The minimum-fare explanation stays available to screen readers only; the display shows just the LEDs.
    fareText: f.minimumApplied
      ? `${t.srPay(textMoney(f.totalKurus))}. ${t.minimumApplied(textMoney(f.meterFareKurus), textMoney(f.minimumFareKurus))}`
      : t.srPay(textMoney(f.totalKurus)),
    legends: { serbest: false, seyir: false, bekleme: false, ucret: true },
    // Tracking is off after BİTİR; only a failed DEVAM attempt can leave a GPS state worth showing here.
    notice: notice(t, s.gps === "weak" || s.gps === "interrupted" || s.gps === "stopped" ? "off" : s.gps, null),
    secondary: acquiring
      ? { action: "cancel", label: t.cancel, enabled: true, armed: false, ariaLabel: t.cancel }
      : { action: "resume", label: t.resume, enabled: true, armed: false, ariaLabel: t.resume },
    primary: {
      action: "clear",
      label: t.clear,
      enabled: wait <= 0 && !acquiring,
      armed: false,
      ariaLabel: wait > 0 ? `${t.clear}, ${t.clearIn(Math.ceil(wait / 1000))}` : t.clear,
    },
  };
}
