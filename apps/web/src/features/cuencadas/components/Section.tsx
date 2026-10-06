import type { ReactNode } from "react";
import { cx } from "../../../shared/ui/cx";
import styles from "./content.module.css";

/** Props for {@link Section}. */
export interface SectionProps {
  /** Anchor id, used by the section links and "Ver programa". */
  id?: string;
  /** Decorative emoji shown before the title. */
  icon?: string;
  title: ReactNode;
  intro?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}

/**
 * A page section in the legacy style: centred column, emoji + section title,
 * optional intro paragraph. Labelled by its heading for landmark navigation.
 */
export function Section({ id, icon, title, intro, children, className }: SectionProps): ReactNode {
  const headingId = id ? `${id}-titulo` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={cx("cu-container", styles.section, className)}>
      <h2 id={headingId} className={styles.sectionTitle}>
        {icon ? <span aria-hidden="true">{icon} </span> : null}
        {title}
      </h2>
      {intro ? <p className={styles.intro}>{intro}</p> : null}
      {children}
    </section>
  );
}
