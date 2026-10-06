/**
 * Display helpers for `/perfil/sesiones` and other auth dates.
 */
import { DATE_LOCALE } from "../../shared/lib/dates";

/**
 * Timezone for auth dates that belong to no Cuencada (invite expiry,
 * session times): the family's home timezone, never the device's.
 */
export const PORTAL_TIME_ZONE = "America/Merida";

/** A short, human summary of a User-Agent. */
export interface DeviceSummary {
  /** Emoji for the device kind. */
  icon: string;
  /** e.g. "iPhone · Safari". */
  label: string;
}

const DEVICES: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/iPhone/, "iPhone", "📱"],
  [/iPad/, "iPad", "📱"],
  [/Android/, "Android", "📱"],
  [/Windows/, "Windows", "💻"],
  [/Macintosh|Mac OS X/, "Mac", "💻"],
  [/CrOS/, "Chromebook", "💻"],
  [/Linux/, "Linux", "💻"]
];

// Order matters: Edge, Opera and Samsung also say "Chrome"; Chrome also says "Safari".
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"]
];

/**
 * Summarizes a raw User-Agent as "device · browser". The UA is only a hint
 * (anyone can fake it); it is rendered as text, never as HTML.
 *
 * @param userAgent - The session's User-Agent, or `null`.
 * @returns The icon and label to show.
 */
export function summarizeUserAgent(userAgent: string | null): DeviceSummary {
  if (userAgent === null || userAgent.trim() === "") return { icon: "🔐", label: "Dispositivo desconocido" };
  const device = DEVICES.find(([pattern]) => pattern.test(userAgent));
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent));
  const parts = [device?.[1], browser?.[1]].filter((part): part is string => part !== undefined);
  return {
    icon: device?.[2] ?? "🔐",
    label: parts.length > 0 ? parts.join(" · ") : "Navegador desconocido"
  };
}

const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60]
];

/**
 * Relative time in Spanish, e.g. "hace 2 minutos". Under a minute reads
 * "ahora". Timezone-independent.
 *
 * @param iso - An ISO instant in the past.
 * @param now - The current time (injectable for tests).
 * @returns The relative phrase.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  if (Number.isNaN(seconds)) return "";
  const format = new Intl.RelativeTimeFormat(DATE_LOCALE, { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  }
  return "ahora";
}
