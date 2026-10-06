import { Badge } from "./Badge";
import styles from "./BottomNav.module.css";
import { cx } from "./cx";
import { type NavItem, type RenderNavLink, isPathActive, renderAnchor } from "./nav";

/** Props for {@link BottomNav}. */
export interface BottomNavProps {
  /** Up to five destinations: Inicio, Programa, Fotos, Chat, Más. */
  items: readonly NavItem[];
  /** Current pathname (e.g. `useLocation().pathname`), used to mark the active tab. */
  currentPath: string;
  /** Custom link renderer (e.g. react-router `Link`). Defaults to `<a>`. */
  renderLink?: RenderNavLink;
  /** Landmark label. Defaults to "Navegación principal". */
  label?: string;
  className?: string | undefined;
}

/**
 * Mobile tab bar fixed to the bottom of the screen, above the home indicator
 * (`safe-area-inset-bottom`). Hidden at ≥900px where {@link TopNav} takes over.
 * The active tab gets `aria-current="page"`.
 */
export function BottomNav({ items, currentPath, renderLink = renderAnchor, label = "Navegación principal", className }: BottomNavProps): React.ReactNode {
  return (
    <nav aria-label={label} className={cx(styles.nav, className)}>
      <ul className={styles.list}>
        {items.map((item) => {
          const isActive = isPathActive(currentPath, item.href, item.end);
          const showBadge = item.badge === true || (typeof item.badge === "number" && item.badge > 0);
          return (
            <li key={item.key} className={styles.item}>
              {renderLink({
                item,
                href: item.href,
                isActive,
                "aria-current": isActive ? "page" : undefined,
                className: cx(styles.link, isActive && styles.active),
                children: (
                  <>
                    <span aria-hidden="true" className={styles.icon}>
                      {item.icon}
                      {showBadge ? (
                        <Badge
                          className={styles.badge}
                          tone="festive"
                          shape={item.badge === true ? "dot" : "count"}
                        >
                          {item.badge === true ? null : item.badge}
                        </Badge>
                      ) : null}
                    </span>
                    <span className={styles.label}>{item.label}</span>
                    {showBadge && item.badgeLabel ? <span className="visually-hidden">, {item.badgeLabel}</span> : null}
                  </>
                )
              })}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
