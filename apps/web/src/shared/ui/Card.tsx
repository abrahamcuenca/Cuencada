import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Card.module.css";
import { cx } from "./cx";

/** Props for {@link Card}. */
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Semantic element. Use `article` for self-contained items (a day in the programa). */
  as?: "div" | "article" | "section" | "li" | "aside";
  /**
   * `default` white card · `brand` green gradient (legacy upload panel) ·
   * `accent` warm gold tint (tips, notices) · `sunken` flat tinted block.
   */
  tone?: "default" | "brand" | "accent" | "sunken";
  /** Inner padding. `none` lets media bleed to the edges. */
  padding?: "none" | "sm" | "md" | "lg";
  /** Leading emoji icon in the legacy card style. Rendered `aria-hidden`. */
  icon?: ReactNode;
  /** Optional heading rendered as `<h3>`. */
  title?: ReactNode;
  children?: ReactNode;
}

/** Rounded content surface (24px radius, ink-tinted shadow) in the legacy card style. */
export function Card({ as: Tag = "div", tone = "default", padding = "md", icon, title, className, children, ...rest }: CardProps): React.ReactNode {
  return (
    <Tag {...rest} className={cx(styles.card, styles[tone], styles[`pad-${padding}`], className)}>
      {icon ? (
        <span aria-hidden="true" className={styles.icon}>
          {icon}
        </span>
      ) : null}
      {title ? <h3 className={styles.title}>{title}</h3> : null}
      {children}
    </Tag>
  );
}
