import type { ReactNode } from "react";
import { Badge } from "./Badge";
import styles from "./TopNav.module.css";
import { cx } from "./cx";
import { type NavItem, type RenderNavLink, isPathActive, renderAnchor } from "./nav";

const BRAND_ITEM: NavItem = { key: "brand", label: "Cuencada", href: "/", end: true };

/** Props for {@link TopNav}. */
export interface TopNavProps {
  items: readonly NavItem[];
  /** Current pathname, used to mark the active link. */
  currentPath: string;
  /** Custom link renderer (e.g. react-router `Link`). Defaults to `<a>`. */
  renderLink?: RenderNavLink;
  /** Brand slot; defaults to the Cuencada logo + wordmark linking to "/". */
  brand?: ReactNode;
  /** Right-hand slot (account menu, "Entrar" button). Visible at every width. */
  actions?: ReactNode;
  /** `hero` = transparent over the green hero (legacy look), `solid` = cream bar. */
  surface?: "solid" | "hero";
  /** Hide the whole bar below 900px (pages that render their own mobile header). */
  hideOnMobile?: boolean;
  label?: string;
  className?: string | undefined;
}

/**
 * App header. Below 900px it is a compact brand bar (destinations live in
 * {@link BottomNav}); at ≥900px the destination links appear inline.
 * Sticky, safe-area aware.
 */
export function TopNav({
  items,
  currentPath,
  renderLink = renderAnchor,
  brand,
  actions,
  surface = "solid",
  hideOnMobile = false,
  label = "Navegación principal",
  className
}: TopNavProps): React.ReactNode {
  return (
    <header className={cx(styles.header, styles[surface], hideOnMobile && styles.hideOnMobile, className)}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          {brand ??
            // Through renderLink so SPA navigation keeps the in-memory session (no full reload).
            renderLink({
              item: BRAND_ITEM,
              href: BRAND_ITEM.href,
              isActive: false,
              "aria-current": undefined,
              className: styles.brandLink ?? "",
              children: (
                <>
                  <img src="/images/logo-96.webp" alt="" width="44" height="44" className={styles.logo} />
                  <span>Cuencada</span>
                </>
              )
            })}
        </div>
        <nav aria-label={label} className={styles.nav}>
          <ul className={styles.list}>
            {items.map((item) => {
              const isActive = isPathActive(currentPath, item.href, item.end);
              const showBadge = item.badge === true || (typeof item.badge === "number" && item.badge > 0);
              return (
                <li key={item.key}>
                  {renderLink({
                    item,
                    href: item.href,
                    isActive,
                    "aria-current": isActive ? "page" : undefined,
                    className: cx(styles.link, isActive && styles.active),
                    children: (
                      <>
                        {item.label}
                        {showBadge ? (
                          <Badge tone="festive" shape={item.badge === true ? "dot" : "count"} {...(item.badgeLabel ? { srLabel: item.badgeLabel } : {})}>
                            {item.badge === true ? null : item.badge}
                          </Badge>
                        ) : null}
                      </>
                    )
                  })}
                </li>
              );
            })}
          </ul>
        </nav>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </header>
  );
}
