import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";
import { cx } from "./cx";

/** Props for {@link EmptyState}. */
export interface EmptyStateProps {
  /** Large emoji, in the legacy card-icon style. */
  icon?: ReactNode;
  /** Short, direct title: "Todavía no hay fotos". */
  title: ReactNode;
  /** What to do next, in plain words. */
  description?: ReactNode;
  /** Primary action (usually a {@link Button}). */
  action?: ReactNode;
  /** `lock` styles the members-only state ("Inicia sesión para ver…"). */
  tone?: "default" | "lock";
  /** Heading level for the title (default h2; 1 when the state is the whole page). */
  headingLevel?: 1 | 2 | 3;
  className?: string | undefined;
}

/** Friendly placeholder for empty lists, members-only locks and error fallbacks. */
export function EmptyState({ icon, title, description, action, tone = "default", headingLevel = 2, className }: EmptyStateProps): React.ReactNode {
  const Heading = headingLevel === 1 ? "h1" : headingLevel === 3 ? "h3" : "h2";
  return (
    <div className={cx(styles.empty, styles[tone], className)}>
      {icon ? (
        <span aria-hidden="true" className={styles.icon}>
          {icon}
        </span>
      ) : null}
      <Heading className={styles.title}>{title}</Heading>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
