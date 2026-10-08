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
import { and, eq, inArray } from "drizzle-orm";
import { profiles, users } from "../../db/schema/index.js";
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
 * Defense in depth: besides the caller's own clearance, the query itself
 * only returns **active** accounts that kept "Aparecer en el directorio" on,
 * so a disabled or unlisted account always gets an empty card.
 *
 * @param db - Client or transaction.
 * @param userIds - Accounts the caller already cleared for this viewer.
 * @returns `userId → row`; accounts without a profile, disabled or unlisted are absent.
 */
export async function loadPersonContactRows(
  db: DbOrTx,
  userIds: readonly string[]
): Promise<ReadonlyMap<string, PersonContactRow>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      phone: profiles.phone,
      whatsapp: profiles.whatsapp,
      instagram: profiles.instagram,
      facebook: profiles.facebook,
      tiktok: profiles.tiktok,
      linkedin: profiles.linkedin,
      github: profiles.github,
      website: profiles.website,
      showEmail: profiles.showEmail,
      showPhone: profiles.showPhone,
      contactVisibility: profiles.contactVisibility
    })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(and(inArray(users.id, ids), eq(users.status, "active"), eq(profiles.listedInDirectory, true)));
  return new Map(rows.map(({ userId, ...row }) => [userId, row]));
}
