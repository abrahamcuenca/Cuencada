import { type ContactItem, contactItemSchema } from "@cuencada/types";
import type { ReactNode } from "react";
import { cx } from "../../../shared/ui/cx";
import { ContactIcon } from "./ContactIcon";
import styles from "./ContactList.module.css";

/** `rel` of every link that leaves the app (WP-4.0: no opener, no referrer, no endorsement). */
export const CONTACT_LINK_REL = "noopener noreferrer nofollow";

/** Props for {@link ContactList}. */
export interface ContactListProps {
  /**
   * The server-built card (`DirectoryEntry.contacts`, `PersonDetails.contacts`).
   * Rendered in the order given; `href`, `label` and `display` are used as-is.
   */
  contacts: readonly ContactItem[];
  /**
   * - `"list"` (default): one full-width row per contact (icon, label and the
   *   server's `display` text). For detail views and the tree "Detalles".
   * - `"chips"`: a wrapping row of round icon-only links (44 px), for dense
   *   lists. The accessible name still carries the label and the value.
   */
  variant?: "list" | "chips";
  /** Whose contacts, for accessible names ("WhatsApp de Ana: +52…"). */
  ownerName?: string;
  /** Shown when there is nothing to list; omitted or `null` renders nothing. */
  emptyText?: string | null;
  className?: string | undefined;
}

/**
 * Tappable contacts of a member (WP-4.4). Reusable outside the directory:
 * WP-4.1 places it in the family tree "Detalles" accordion.
 *
 * Security: links are never built here. Each item is re-checked against the
 * contract's `contactItemSchema` (only `https://`, `mailto:` and `tel:+digits`)
 * and skipped if it fails. `https` links open in a new tab with
 * `rel="noopener noreferrer nofollow"`; `tel:`/`mailto:` open natively.
 *
 * @example
 * <ContactList contacts={entry.contacts ?? []} ownerName={entry.displayName} emptyText="No comparte datos de contacto." />
 */
export function ContactList({ contacts, variant = "list", ownerName, emptyText = null, className }: ContactListProps): ReactNode {
  const safe = contacts.filter((item) => contactItemSchema.safeParse(item).success);
  if (safe.length === 0) {
    return emptyText === null ? null : <p className={cx(styles.empty, className)}>{emptyText}</p>;
  }
  const listLabel = ownerName === undefined ? "Contacto" : `Contacto de ${ownerName}`;
  return (
    <ul className={cx(variant === "chips" ? styles.chips : styles.list, className)} aria-label={listLabel}>
      {safe.map((item) => (
        <li key={item.kind}>
          <ContactLink item={item} variant={variant} ownerName={ownerName} />
        </li>
      ))}
    </ul>
  );
}

function ContactLink({ item, variant, ownerName }: { item: ContactItem; variant: "list" | "chips"; ownerName: string | undefined }): ReactNode {
  const external = item.href.startsWith("https://");
  const linkProps = external ? { target: "_blank", rel: CONTACT_LINK_REL } : {};
  const newTab = external ? " (se abre en otra pestaña)" : "";

  if (variant === "chips") {
    const owner = ownerName === undefined ? "" : ` de ${ownerName}`;
    return (
      <a
        href={item.href}
        {...linkProps}
        className={cx(styles.chip, styles[item.kind])}
        aria-label={`${item.label}${owner}: ${item.display}${newTab}`}
        title={`${item.label}: ${item.display}`}
      >
        <ContactIcon kind={item.kind} className={styles.chipIcon} />
      </a>
    );
  }

  return (
    <a href={item.href} {...linkProps} className={styles.row}>
      <span className={cx(styles.badge, styles[item.kind])}>
        <ContactIcon kind={item.kind} className={styles.rowIcon} />
      </span>
      <span className={styles.text}>
        <span className={styles.label}>{item.label}</span>
        <span className={styles.display} translate="no">
          {item.display}
        </span>
      </span>
      {external ? (
        <>
          <span aria-hidden="true" className={styles.external}>
            ↗
          </span>
          <span className="visually-hidden">{newTab}</span>
        </>
      ) : null}
    </a>
  );
}
