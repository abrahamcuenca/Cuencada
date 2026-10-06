import type { ReactNode } from "react";
import styles from "./PageShell.module.css";
import { cx } from "./cx";

/** Props for {@link PageShell}. */
export interface PageShellProps {
  /** Usually a {@link TopNav}. */
  header?: ReactNode;
  /** Offline / update banners, shown under the header. */
  banner?: ReactNode;
  /** Usually a {@link BottomNav}; the shell reserves space so content never hides under it. */
  bottomNav?: ReactNode;
  /** Site footer (legacy dark-green footer). Hidden behind the bottom nav padding on mobile. */
  footer?: ReactNode;
  /** `contained` = centred column with gutters; `bleed` = full width (heroes manage their own gutters). */
  layout?: "contained" | "bleed";
  /** id of `<main>`, target of the "Saltar al contenido" skip link. */
  mainId?: string;
  children: ReactNode;
  className?: string | undefined;
}

/**
 * Page frame: skip link, header, optional banner, `<main>` and bottom nav,
 * with safe-area padding and room reserved for the fixed bottom nav (<900px).
 */
export function PageShell({ header, banner, bottomNav, footer, layout = "contained", mainId = "contenido", children, className }: PageShellProps): React.ReactNode {
  return (
    <div className={cx(styles.shell, bottomNav ? styles.withBottomNav : null, className)}>
      <a href={`#${mainId}`} className="cu-skip-link">
        Saltar al contenido
      </a>
      {header}
      {banner ? <div className={styles.banner}>{banner}</div> : null}
      <main id={mainId} tabIndex={-1} className={cx(styles.main, layout === "contained" ? "cu-container" : styles.bleed)}>
        {children}
      </main>
      {footer}
      {bottomNav}
    </div>
  );
}
