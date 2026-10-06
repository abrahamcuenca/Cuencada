import type { ReactNode } from "react";
import styles from "./Countdown.module.css";
import { type Countdown as CountdownTime, computeCountdown } from "../lib/dates";
import { cx } from "./cx";

/** Phase of an edition relative to `now`. */
export type CountdownPhase = "upcoming" | "live" | "past";

type Instant = Date | number;

const toDate = (value: Instant): Date => (typeof value === "number" ? new Date(value) : value);

/**
 * Phase and remaining time, built on `computeCountdown` (the single countdown
 * implementation, `shared/lib/dates.ts`).
 * - `upcoming` while now < target
 * - `live` from target until `end` (or forever when `end` is omitted)
 * - `past` once now ≥ end
 */
function countdownState(target: Instant, now: Instant, end: Instant | undefined): { phase: CountdownPhase; remaining: CountdownTime } {
  const remaining = computeCountdown(toDate(target), toDate(now));
  if (!remaining.isPast) return { phase: "upcoming", remaining };
  const over = end !== undefined && computeCountdown(toDate(end), toDate(now)).isPast;
  return { phase: over ? "past" : "live", remaining };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Props for {@link Countdown}. */
export interface CountdownProps {
  /** Start of the edition (in the Cuencada's timezone, already resolved to an instant). */
  target: Instant;
  /** Current time; re-render every second from the parent to tick. */
  now: Instant;
  /** End of the edition; after it the past state is shown. */
  end?: Instant;
  /** Message while the edition is happening. */
  liveMessage?: ReactNode;
  /** Message once it is over. */
  pastMessage?: ReactNode;
  /** `dark` for the green hero (legacy), `light` for cream pages. */
  surface?: "dark" | "light";
  className?: string | undefined;
}

/**
 * Presentational countdown (legacy hero tiles). Shows días/horas/minutos/segundos,
 * then "🎉 ¡YA LLEGÓ LA CUENCADA! 🎉" while live, then a past-edition message.
 * Not a live region: a ticking timer must not spam screen readers; the
 * accessible name summarises the remaining time instead.
 */
export function Countdown({
  target,
  now,
  end,
  liveMessage = "¡YA LLEGÓ LA CUENCADA!",
  pastMessage = "Gracias por ser parte de esta historia. ¡Nos vemos en la próxima Cuencada!",
  surface = "dark",
  className
}: CountdownProps): React.ReactNode {
  const { phase, remaining: parts } = countdownState(target, now, end);
  const rootClass = cx(styles.countdown, styles[surface], className);

  if (phase === "live") {
    return (
      <div className={cx(rootClass, styles.message, styles.live)} data-phase="live">
        <span aria-hidden="true">🎉</span> <strong>{liveMessage}</strong> <span aria-hidden="true">🎉</span>
      </div>
    );
  }

  if (phase === "past") {
    return (
      <div className={cx(rootClass, styles.message, styles.past)} data-phase="past">
        <span aria-hidden="true">💛</span> <span>{pastMessage}</span>
      </div>
    );
  }

  const summary = `Faltan ${plural(parts.days, "día", "días")}, ${plural(parts.hours, "hora", "horas")} y ${plural(parts.minutes, "minuto", "minutos")}`;
  const units: Array<[number, string, string]> = [
    [parts.days, "día", "días"],
    [parts.hours, "hora", "horas"],
    [parts.minutes, "minuto", "minutos"],
    [parts.seconds, "segundo", "segundos"]
  ];

  return (
    <div role="timer" aria-label={summary} className={cx(rootClass, styles.grid)} data-phase="upcoming">
      {units.map(([value, one, many], index) => (
        <div key={many} className={styles.unit} aria-hidden="true">
          <b className={styles.value}>{index === 0 ? value : String(value).padStart(2, "0")}</b>
          <span className={styles.label}>{value === 1 ? one : many}</span>
        </div>
      ))}
    </div>
  );
}
