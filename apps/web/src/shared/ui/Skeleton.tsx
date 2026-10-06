import type { CSSProperties } from "react";
import styles from "./Skeleton.module.css";
import { cx } from "./cx";

/** Props for {@link Skeleton}. */
export interface SkeletonProps {
  /** `text` = one line, `block` = rectangle (cards, photos), `circle` = avatar. */
  shape?: "text" | "block" | "circle";
  /** CSS width (e.g. "60%", 48). */
  width?: CSSProperties["width"];
  /** CSS height (ignored for `text`, which uses 1em). */
  height?: CSSProperties["height"];
  /** Number of text lines (last line is shorter). */
  lines?: number;
  className?: string | undefined;
}

/**
 * Placeholder shimmer while content loads. Always `aria-hidden`; pair the
 * loading region with `aria-busy="true"` or a {@link Spinner} label.
 * The shimmer is disabled under `prefers-reduced-motion`.
 */
export function Skeleton({ shape = "text", width, height, lines = 1, className }: SkeletonProps): React.ReactNode {
  if (shape === "text" && lines > 1) {
    return (
      <span aria-hidden="true" className={cx(styles.lines, className)}>
        {Array.from({ length: lines }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder lines never reorder.
          <span key={i} className={cx(styles.skeleton, styles.text)} style={{ width: i === lines - 1 ? "60%" : (width ?? "100%") }} />
        ))}
      </span>
    );
  }
  const style: CSSProperties = { width: width ?? (shape === "circle" ? 48 : "100%") };
  if (shape !== "text") style.height = height ?? (shape === "circle" ? style.width : 120);
  return <span aria-hidden="true" className={cx(styles.skeleton, styles[shape], className)} style={style} />;
}
