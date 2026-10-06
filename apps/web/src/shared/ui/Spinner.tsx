import { cx } from "./cx";
import styles from "./Spinner.module.css";

/** Props for {@link Spinner}. */
export interface SpinnerProps {
  /** Accessible label announced to screen readers. Defaults to "Cargando…". */
  label?: string;
  /** Visual size. `inline` inherits the current font size (used inside buttons). */
  size?: "inline" | "md" | "lg";
  /** When true the spinner is decorative (the parent already announces state). */
  decorative?: boolean;
  className?: string | undefined;
}

/**
 * Indeterminate loading indicator. Announces its label through `role="status"`
 * unless `decorative` is set. Animation stops under `prefers-reduced-motion`
 * (it becomes a static ring, still conveying "busy" through the label).
 */
export function Spinner({ label = "Cargando…", size = "md", decorative = false, className }: SpinnerProps): React.ReactNode {
  if (decorative) {
    return <span aria-hidden="true" className={cx(styles.spinner, styles[size], className)} />;
  }
  return (
    <output className={cx(styles.wrap, className)}>
      <span aria-hidden="true" className={cx(styles.spinner, styles[size])} />
      <span className="visually-hidden">{label}</span>
    </output>
  );
}
