import type { ReactNode } from "react";
import { cx } from "../../../shared/ui/cx";
import styles from "./content.module.css";

/** Props for {@link CuencadaHero}. */
export interface CuencadaHeroProps {
  /** Location/date line ("Mérida · Yucatán · 13—18 de septiembre de 2026"). */
  kicker: ReactNode;
  /** `display` = the "CUENCADA" wordmark (Home); `page` = an edition title. */
  titleStyle: "display" | "page";
  title: ReactNode;
  /** Tagline or description under the title. */
  lead?: ReactNode;
  /** Buttons (use `surface="dark"`). */
  actions?: ReactNode;
  /** Countdown or other content below the actions. */
  children?: ReactNode;
  /** `https:` or `/images/…` hero photo, already checked. */
  imageUrl?: string | null;
}

/**
 * The legacy green hero with the papel picado edge (the page's one flourish).
 * Holds the page's `<h1>`.
 */
export function CuencadaHero({ kicker, titleStyle, title, lead, actions, children, imageUrl }: CuencadaHeroProps): ReactNode {
  return (
    <section className={cx("cu-hero-surface", "cu-papel-picado", styles.hero)} aria-labelledby="cuencada-hero-title">
      {imageUrl ? <img className={styles.heroImage} src={imageUrl} alt="" fetchPriority="high" /> : null}
      <div className={cx("cu-container", styles.heroInner)}>
        <p className="cu-kicker">{kicker}</p>
        <h1 id="cuencada-hero-title" className={titleStyle === "display" ? styles.heroDisplay : styles.heroTitle}>
          {title}
        </h1>
        {lead ? <p className={styles.heroLead}>{lead}</p> : null}
        {actions ? <div className={styles.heroActions}>{actions}</div> : null}
        {children ? <div className={styles.heroExtra}>{children}</div> : null}
      </div>
    </section>
  );
}
