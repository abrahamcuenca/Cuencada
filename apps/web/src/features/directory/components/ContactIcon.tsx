import type { ContactKind } from "@cuencada/types";
import type { ReactNode } from "react";

/**
 * Simple line icons per contact kind, drawn inline (no icon font, no network
 * request, no `style` attribute: CSP `style-src 'self'` and `img-src` stay
 * untouched). Generic shapes in the spirit of each network, not brand logos.
 * Decorative: the surrounding link carries the accessible name.
 */
const PATHS: Record<ContactKind, ReactNode> = {
  email: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 6.5 8.5 6.5 8.5-6.5" />
    </>
  ),
  phone: <path d="M6.6 3.5h2.6l1.4 4-2 1.3a12 12 0 0 0 6.6 6.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z" />,
  whatsapp: (
    <>
      <path d="M4 20.5 5.3 16.6A8.5 8.5 0 1 1 8.6 19.5Z" />
      <path d="M9.2 8.6c.2-.5.6-.6 1-.5l.9 1.9-.7.8a5.6 5.6 0 0 0 2.8 2.8l.8-.7 1.9.9c.1.4 0 .8-.5 1a3 3 0 0 1-2.6.2 7.8 7.8 0 0 1-4-4 3 3 0 0 1 .4-2.4Z" />
    </>
  ),
  instagram: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="0.6" />
    </>
  ),
  facebook: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M15.5 8h-1.6a1.9 1.9 0 0 0-1.9 1.9V20.5M10 13h5" />
    </>
  ),
  tiktok: <path d="M13 4v10.5a3.5 3.5 0 1 1-3.5-3.5M13 4c.4 2.6 2.2 4.4 5 4.6" />,
  linkedin: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M8 10.5V16.5M8 7.6v.1M11.5 16.5v-6M11.5 13a2.5 2.5 0 0 1 5 0v3.5" />
    </>
  ),
  github: (
    <>
      <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4" />
      <path d="m13.2 6.5-2.4 11" />
    </>
  ),
  website: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5Z" />
    </>
  )
};

/** Props for {@link ContactIcon}. */
export interface ContactIconProps {
  kind: ContactKind;
  /** CSS class for size and colour (the icon uses `currentColor`). */
  className?: string | undefined;
}

/**
 * The 24×24 line icon for a contact kind (decorative, `aria-hidden`).
 *
 * @param props - {@link ContactIconProps}.
 */
export function ContactIcon({ kind, className }: ContactIconProps): ReactNode {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[kind]}
    </svg>
  );
}
