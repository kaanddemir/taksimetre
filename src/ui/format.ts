import { formatKurus } from "../engine/fare.ts";

/** "551.94" for the LED (dot as on real meters). */
export const ledMoney = (kurus: number): string => formatKurus(kurus);

/** "551,94 ₺" for text and screen readers (Turkish decimal comma). */
export const textMoney = (kurus: number): string => `${formatKurus(kurus).replace(".", ",")} ₺`;

/** Physical distance, truncated to 10 m: 1_234_567 mm -> "1.23". */
export function ledKm(mm: number): string {
  const tensOfMeters = Math.trunc(mm / 10_000);
  return `${Math.trunc(tensOfMeters / 100)}.${String(tensOfMeters % 100).padStart(2, "0")}`;
}

/** Elapsed time "H:MM:SS" (up to 9:59:59), then "HH:MM:SS". */
export function ledDuration(ms: number): string {
  const s = Math.trunc(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.trunc(s / 3600)}:${pad(Math.trunc(s / 60) % 60)}:${pad(s % 60)}`;
}
