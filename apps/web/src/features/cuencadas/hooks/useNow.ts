import { useEffect, useState } from "react";
import { computeCountdown } from "../../../shared/lib/dates";

/**
 * The current time, ticking every second until `stopAt` (e.g. the end of an
 * edition). After that the clock stops, so a past edition costs no timers.
 *
 * @param stopAt - ISO instant after which ticking stops; `null` never ticks.
 * @returns The current `Date`.
 */
export function useNow(stopAt: string | null): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (stopAt === null || computeCountdown(stopAt, new Date()).isPast) return undefined;
    const timer = window.setInterval(() => {
      const next = new Date();
      setNow(next);
      if (computeCountdown(stopAt, next).isPast) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [stopAt]);

  return now;
}
