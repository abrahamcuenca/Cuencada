import { useEffect, useRef, useState } from "react";
import { toZonedParts } from "../../../shared/lib/dates";
import { todayInTimezone } from "../lib/format";

/** Small slack after midnight so the new day is surely visible to `Intl` and the server. */
const MIDNIGHT_SLACK_MS = 1_000;

/** Adds whole days to a `YYYY-MM-DD` calendar date (no timezone involved). */
function addDays(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * The instant a calendar day starts in `timeZone`. Two passes of "guess,
 * measure the zone's offset, correct" handle any offset and a DST change.
 *
 * @param date - `YYYY-MM-DD`.
 * @param timeZone - IANA timezone.
 * @returns Milliseconds since the epoch.
 */
export function zonedDayStart(date: string, timeZone: string): number {
  const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = toZonedParts(new Date(guess), timeZone);
    guess += target - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  }
  return guess;
}

/**
 * Milliseconds from `now` until the next local midnight in `timeZone`.
 *
 * @param now - The current instant.
 * @param timeZone - IANA timezone.
 * @returns A positive delay (at least 1 ms).
 */
export function msUntilNextMidnight(now: Date, timeZone: string): number {
  const tomorrow = addDays(todayInTimezone(now, timeZone), 1);
  return Math.max(1, zonedDayStart(tomorrow, timeZone) - now.getTime());
}

/**
 * Today's date (`YYYY-MM-DD`) in `timeZone`, updated by one timer set to the
 * next local midnight (no per-second ticking), and re-checked when the tab
 * becomes visible again (timers sleep with the device).
 *
 * @param timeZone - The edition's IANA timezone.
 * @returns The current local date.
 */
export function useZonedToday(timeZone: string): string {
  const [today, setToday] = useState(() => todayInTimezone(new Date(), timeZone));

  useEffect(() => {
    let timer: number | undefined;
    const refresh = (): void => {
      const now = new Date();
      setToday(todayInTimezone(now, timeZone));
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, msUntilNextMidnight(now, timeZone) + MIDNIGHT_SLACK_MS);
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [timeZone]);

  return today;
}

/**
 * Calls `onNewDay` when the local date in `timeZone` changes while mounted
 * (e.g. to refetch today's message after midnight). Not called on mount.
 *
 * @param timeZone - The edition's IANA timezone.
 * @param onNewDay - Callback; may change between renders.
 * @returns Today's local date.
 */
export function useOnNewDay(timeZone: string, onNewDay: () => void): string {
  const today = useZonedToday(timeZone);
  const seen = useRef(today);
  const callback = useRef(onNewDay);
  callback.current = onNewDay;
  useEffect(() => {
    if (seen.current === today) return;
    seen.current = today;
    callback.current();
  }, [today]);
  return today;
}
