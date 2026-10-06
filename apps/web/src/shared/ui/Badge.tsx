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
  children?: ReactNode;
  className?: string | undefined;
}

/**
 * Small status label. Use `pill` for tags and statuses ("Confirmado", "Solo miembros"),
 * `count` for unread messages (caps at 99+), and `dot` for "new" markers.
 */
export function Badge({ tone = "brand", shape = "pill", srLabel, children, className }: BadgeProps): React.ReactNode {
  let content = children;
  if (shape === "count" && typeof children === "number") content = children > 99 ? "99+" : String(children);
  if (shape === "dot") content = null;
  return (
    <span className={cx(styles.badge, styles[tone], styles[shape], className)}>
      <span aria-hidden={srLabel ? true : undefined}>{content}</span>
      {srLabel ? <span className="visually-hidden">{srLabel}</span> : null}
    </span>
  );
}
