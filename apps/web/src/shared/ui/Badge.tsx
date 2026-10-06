import type { ReactNode } from "react";
import styles from "./Badge.module.css";
import { cx } from "./cx";

/** Colour role of a {@link Badge}. */
export type BadgeTone = "neutral" | "brand" | "accent" | "festive" | "success" | "danger";

/** Props for {@link Badge}. */
export interface BadgeProps {
  tone?: BadgeTone;
  /** `pill` = legacy tag ("🚌 Transporte incluido"), `count` = unread counter, `dot` = presence dot. */
  shape?: "pill" | "count" | "dot";
  /** Screen-reader text when the visible content is terse (counts, dots). */
  srLabel?: string;
  /**
   * Largest count shown as-is for `count` badges; larger numbers show as
   * `${max}+`. Defaults to 99 ("99+"); chat rooms use 999 ("999+").
   */
  max?: number;
  children?: ReactNode;
  className?: string | undefined;
}

/**
 * Text of a `count` badge: the number, or `${max}+` above `max`.
 *
 * @param count - The unread count.
 * @param max - Cap (a positive integer; anything else falls back to 99).
 */
export function formatCount(count: number, max = 99): string {
  const cap = Number.isInteger(max) && max > 0 ? max : 99;
  return count > cap ? `${cap}+` : String(count);
}

/**
 * Small status label. Use `pill` for tags and statuses ("Confirmado", "Solo miembros"),
 * `count` for unread messages (caps at `max`, "99+" by default), and `dot` for "new" markers.
 */
export function Badge({ tone = "brand", shape = "pill", srLabel, max = 99, children, className }: BadgeProps): React.ReactNode {
  let content = children;
  if (shape === "count" && typeof children === "number") content = formatCount(children, max);
  if (shape === "dot") content = null;
  return (
    <span className={cx(styles.badge, styles[tone], styles[shape], className)}>
      <span aria-hidden={srLabel ? true : undefined}>{content}</span>
      {srLabel ? <span className="visually-hidden">{srLabel}</span> : null}
    </span>
  );
}
