import type { ReactNode } from "react";
import styles from "./Countdown.module.css";
import { cx } from "./cx";

/** Phase of an edition relative to `now`. */
export type CountdownPhase = "upcoming" | "live" | "past";

/** Result of {@link getCountdown}. */
export interface CountdownParts {
  phase: CountdownPhase;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

type Instant = Date | number;

const toMs = (value: Instant): number => (typeof value === "number" ? value : value.getTime());

/**
 * Splits the time between `now` and `target` into días/horas/minutos/segundos.
 * - `upcoming` while now < target
 * - `live` from target until `end` (or forever when `end` is omitted)
 * - `past` once now ≥ end
 * Pure: the caller owns the clock (pass a ticking `now` from a hook).
 */
export function getCountdown(target: Instant, now: Instant, end?: Instant): CountdownParts {
  const nowMs = toMs(now);
  const diff = toMs(target) - nowMs;
  if (diff <= 0) {
    const phase: CountdownPhase = end !== undefined && nowMs >= toMs(end) ? "past" : "live";
    return { phase, days: 0, hours: 0, minutes: 0, seconds: 0 };
  }
  const totalSeconds = Math.floor(diff / 1000);
  return {
    phase: "upcoming",
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60
  };
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
  const parts = getCountdown(target, now, end);
  const rootClass = cx(styles.countdown, styles[surface], className);

  if (parts.phase === "live") {
    return (
      <div className={cx(rootClass, styles.message, styles.live)} data-phase="live">
        <span aria-hidden="true">🎉</span> <strong>{liveMessage}</strong> <span aria-hidden="true">🎉</span>
      </div>
    );
  }

  if (parts.phase === "past") {
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
