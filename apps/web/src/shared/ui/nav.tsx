import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/** One destination in {@link BottomNav} or {@link TopNav}. */
export interface NavItem {
  /** Stable key, e.g. "inicio". */
  key: string;
  /** Visible Spanish label, e.g. "Programa". */
  label: string;
  /** Target path, e.g. "/cuencada/2026". */
  href: string;
  /** Emoji or SVG icon (decorative). */
  icon?: ReactNode;
  /** Unread count or dot; `0`/undefined hides it. `true` shows a dot. */
  badge?: number | true;
  /** Accessible description of the badge, e.g. "3 mensajes sin leer". */
  badgeLabel?: string;
  /** Match only the exact path (use for "/" so it is not active everywhere). */
  end?: boolean;
}

/** Props passed to a custom link renderer so navs stay router-agnostic. */
export interface NavLinkRenderProps {
  item: NavItem;
  href: string;
  className: string;
  isActive: boolean;
  "aria-current": "page" | undefined;
  children: ReactNode;
}

/** Renders a link element. Default renders `<a>`; pass one built on react-router's `Link`. */
export type RenderNavLink = (props: NavLinkRenderProps) => ReactNode;

/**
 * True when `currentPath` is `href` or a sub-path of it (`end` forces exact match).
 * Normalises trailing slashes.
 */
export function isPathActive(currentPath: string, href: string, end = false): boolean {
  const strip = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const current = strip(currentPath);
  const target = strip(href);
  if (end || target === "/") return current === target;
  return current === target || current.startsWith(`${target}/`);
}

/**
 * Renderer for apps inside a react-router data router: client-side navigation
 * via `Link`. Pair it with `currentPath={useLocation().pathname}`.
 */
export const renderRouterLink: RenderNavLink = ({ href, className, children, "aria-current": ariaCurrent }) => (
  <Link to={href} className={className} aria-current={ariaCurrent}>
    {children}
  </Link>
);

/** Default renderer: a plain anchor. */
export const renderAnchor: RenderNavLink = ({ href, className, children, "aria-current": ariaCurrent }) => (
  <a href={href} className={className} aria-current={ariaCurrent}>
    {children}
  </a>
);
