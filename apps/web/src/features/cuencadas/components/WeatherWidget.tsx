import { type ReactNode, useEffect, useRef, useState } from "react";
import { Card } from "../../../shared/ui/Card";
import styles from "./content.module.css";

/** The only origin we talk to (exact match, no subdomains). */
export const WEATHER_ORIGIN = "https://weatherwidget.io";
/** weatherwidget.io's own widget frame, the same one its loader script creates. */
export const WEATHER_FRAME_SRC = "https://weatherwidget.io/w/";
/** Id the frame echoes back as `wwId` (the loader names its first widget like this). */
export const WEATHER_FRAME_ID = "weatherwidget-io-0";
/** Height before the widget reports its own (the loader's default). */
export const WEATHER_DEFAULT_HEIGHT = 150;
/** Accepted height range (Security L6): a frame cannot shrink to nothing or push the page around. */
export const WEATHER_MIN_HEIGHT = 150;
export const WEATHER_MAX_HEIGHT = 250;

/** Style keys the loader always sends; `null` = the widget's default. */
const STYLE_KEYS = [
  "font",
  "icons",
  "mode",
  "days",
  "basecolor",
  "accent",
  "textcolor",
  "textAccent",
  "highcolor",
  "lowcolor",
  "suncolor",
  "mooncolor",
  "cloudcolor",
  "cloudfill",
  "raincolor",
  "snowcolor",
  "windcolor",
  "fogcolor",
  "thundercolor",
  "hailcolor",
  "dayscolor",
  "tempcolor",
  "desccolor",
  "label1color",
  "label2color",
  "shadow",
  "scale"
] as const;

/** The config message weatherwidget.io's frame expects (what its loader builds from the anchor's `data-*`). */
export type WeatherWidgetConfig = {
  id: string;
  href: string;
  label_1: string;
  label_2: string;
  theme: string;
} & Record<(typeof STYLE_KEYS)[number], null>;

/**
 * The forecast7.com page to show, or `null` when `value` is not an
 * `https://forecast7.com/…` URL (the only kind weatherwidget.io renders).
 *
 * @param value - `weatherWidgetUrl` from the API.
 * @returns The canonical URL, or `null`.
 */
export function forecastUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "forecast7.com" || url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Builds the config message, mirroring the legacy anchor
 * (`data-label_1="MERIDA, YUCATÁN" data-label_2="CLIMA" data-theme="original"`).
 *
 * @param href - A URL accepted by {@link forecastUrl}.
 * @param city - The Cuencada's city.
 * @param state - The Cuencada's state.
 * @returns The object to `postMessage` to the frame.
 */
export function weatherWidgetConfig(href: string, city: string, state: string): WeatherWidgetConfig {
  const styleDefaults = Object.fromEntries(STYLE_KEYS.map((key) => [key, null])) as Record<(typeof STYLE_KEYS)[number], null>; // built from STYLE_KEYS, so every key is present
  return {
    ...styleDefaults,
    id: WEATHER_FRAME_ID,
    href,
    label_1: [city, state].filter(Boolean).join(", ").toLocaleUpperCase("es-MX"),
    label_2: "CLIMA",
    theme: "original"
  };
}

/**
 * Reads the height the frame reports (`{ wwId, wwHeight }`). Anything else is
 * ignored; the height is clamped to 150–250px (Security L6) so a hostile frame cannot blow up the page.
 *
 * @param data - `MessageEvent.data` from the weatherwidget.io frame.
 * @returns A height in px, or `null`.
 */
export function readWidgetHeight(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const id: unknown = Reflect.get(data, "wwId");
  const height: unknown = Reflect.get(data, "wwHeight");
  if (id !== WEATHER_FRAME_ID) return null;
  const value = typeof height === "string" ? Number(height) : height;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(WEATHER_MAX_HEIGHT, Math.max(WEATHER_MIN_HEIGHT, Math.round(value)));
}

/** Props for {@link WeatherWidget}. */
export interface WeatherWidgetProps {
  /** A forecast7.com URL, already checked with {@link forecastUrl}. */
  href: string;
  city: string;
  state: string;
}

/**
 * The legacy weatherwidget.io forecast, embedded **without its loader script** [SEC].
 *
 * We render weatherwidget.io's own frame and do the loader's job ourselves:
 * on `load` we post the config to exactly `https://weatherwidget.io`, and we
 * accept only that origin's height messages from this frame's window. No
 * third-party script ever runs in our document, so nothing can reach the
 * in-memory access token. `allow-same-origin` in the sandbox refers to
 * weatherwidget.io's own (cross-origin) origin, which its frame needs.
 */
/*
 * Rendered only by `/cuencada/:year`, inside its "Clima en {ciudad}" section, boxed in a Card.
 */
export function WeatherWidget({ href, city, state }: WeatherWidgetProps): ReactNode {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(WEATHER_DEFAULT_HEIGHT);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current;
      if (frame === null || event.origin !== WEATHER_ORIGIN || event.source !== frame.contentWindow) return;
      const next = readWidgetHeight(event.data);
      if (next !== null) setHeight(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const sendConfig = (): void => {
    frameRef.current?.contentWindow?.postMessage(weatherWidgetConfig(href, city, state), WEATHER_ORIGIN);
  };

  return (
    <Card padding="sm" className={styles.weather}>
      <iframe
        ref={frameRef}
        className={styles.weatherFrame}
        style={{ height }}
        src={WEATHER_FRAME_SRC}
        title={`Clima en ${city}`}
        sandbox="allow-scripts allow-same-origin allow-popups"
        referrerPolicy="no-referrer"
        loading="lazy"
        onLoad={sendConfig}
      />
      <a className={styles.weatherLink} href={href} target="_blank" rel="noopener noreferrer">
        Ver pronóstico completo
      </a>
    </Card>
  );
}
