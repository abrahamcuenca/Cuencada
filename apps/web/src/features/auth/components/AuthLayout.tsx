import type { ReactNode } from "react";
import styles from "../auth.module.css";

/** Props for {@link AuthLayout}. */
export interface AuthLayoutProps {
  /** Page heading (h1). */
  title: ReactNode;
  /** Decorative emoji before the heading. */
  icon?: string;
  /** Lead paragraph under the heading. */
  lead?: ReactNode;
  children: ReactNode;
}

/**
 * Shared frame of every auth screen (wireframes §3): a single card on cream
 * with the logo, the heading and the form. At ≥900px the page splits 50/50
 * with the green hero panel and its papel picado edge on the left.
 */
export function AuthLayout({ title, icon, lead, children }: AuthLayoutProps): ReactNode {
  return (
    <div className={styles.page}>
      <aside className={`${styles.hero} cu-hero-surface cu-papel-picado`} aria-hidden="true">
        <p className={styles.heroWordmark}>Cuencada</p>
        <p className={styles.heroTagline}>Una familia. Una historia. Una celebración.</p>
      </aside>
      <section className={styles.card} aria-labelledby="auth-title">
        <img className={styles.logo} src="/images/logo-96.webp" alt="" width={72} height={72} />
        <h1 id="auth-title" className={styles.title}>
          {icon ? <span aria-hidden="true">{icon} </span> : null}
          {title}
        </h1>
        {lead ? <p className={styles.lead}>{lead}</p> : null}
        {children}
      </section>
    </div>
  );
}
