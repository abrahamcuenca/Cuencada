/**
 * Contacts of a linked person for `PersonDetails.contacts` (WP-4.0 interface;
 * ADR 0001 §6 "contact visibility").
 *
 * Ownership: WP-4.1 (the `PersonDetails` builder) **calls** these after it
 * has decided the viewer may see contacts at all (verified member; account
 * linked, listed and active). WP-4.4 **implements** the profile query; the
 * card itself is the shared `buildContactCard` from `@cuencada/types`.
 */
import { type ContactCard, type ContactSource, buildContactCard, toContactVisibility } from "@cuencada/types";
import type { DbOrTx } from "../../lib/audit.js";

/** A linked account's stored contacts plus its visibility columns. */
export interface PersonContactRow extends ContactSource {
  /** `profiles.show_email`. */
  showEmail: boolean;
  /** `profiles.show_phone`. */
  showPhone: boolean;
  /** `profiles.contact_visibility` (untrusted jsonb; read fail-closed). */
  contactVisibility: unknown;
}

/**
 * Card for one linked account, honouring each per-field switch. `null` (no
 * account, or no profile) gives an empty card.
 *
 * @param row - From {@link loadPersonContactRows}, or `null`.
 * @returns The visible contacts as server-built links.
 */
export function personContactCard(row: PersonContactRow | null): ContactCard {
  if (row === null) return [];
  return buildContactCard(row, toContactVisibility(row.showEmail, row.showPhone, row.contactVisibility));
}

/**
 * Load the contact rows of several linked accounts in **one** query
 * (`users.email` + `profiles` contact columns), keyed by user id.
 *
 * @param db - Client or transaction.
 * @param userIds - Accounts the caller already cleared for this viewer.
 * @returns `userId → row`; accounts without a profile are absent.
 */
export async function loadPersonContactRows(
  db: DbOrTx,
  userIds: readonly string[]
): Promise<ReadonlyMap<string, PersonContactRow>> {
  // TODO(WP-4.4): select users.email and profiles.{phone, whatsapp, instagram, facebook,
  // tiktok, linkedin, github, website, show_email, show_phone, contact_visibility}
  // where user_id = any(userIds). Until then every card is empty (fail closed).
  void db;
  void userIds;
  return new Map();
}
