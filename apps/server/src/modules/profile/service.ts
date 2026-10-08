/**
 * Own-profile reads and writes. The caller's profile row is created lazily
 * (full name = display name) if an account somehow has none.
 */
import {
  isE164,
  type OwnContacts,
  type OwnProfile,
  STORED_CONTACT_VISIBILITY_KEYS,
  type StoredContactVisibility,
  toContactVisibility,
  type UpdateContactsInput,
  type UpdateProfileInput
} from "@cuencada/types";
import { eq } from "drizzle-orm";
import { people, profiles, users } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { type AvatarUrlDeps, avatarUrlFor } from "./avatar.js";

type ProfileRow = typeof profiles.$inferSelect;

/** The caller's rows needed for {@link OwnProfile}. */
export interface OwnProfileRecord {
  profile: ProfileRow;
  email: string;
  displayName: string;
  personId: string | null;
}

/**
 * Make sure `userId` has a profile row (idempotent; concurrent callers are safe).
 *
 * @param db - Client or transaction.
 * @param userId - The account.
 */
export async function ensureProfile(db: DbOrTx, userId: string): Promise<void> {
  const [existing] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (existing !== undefined) return;
  const [user] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
  if (user === undefined) throw new AppError("NOT_FOUND");
  await db
    .insert(profiles)
    .values({ userId, fullName: user.displayName })
    .onConflictDoNothing({ target: profiles.userId });
}

/**
 * Load the caller's profile, creating the row if missing.
 *
 * @param db - Client or transaction.
 * @param userId - The authenticated user.
 * @param options - `forUpdate` locks the profile row (inside a transaction).
 */
export async function loadOwnProfile(
  db: DbOrTx,
  userId: string,
  options: { forUpdate?: boolean } = {}
): Promise<OwnProfileRecord> {
  await ensureProfile(db, userId);
  const query = db
    .select({
      profile: profiles,
      email: users.email,
      displayName: users.displayName,
      personId: people.id
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .leftJoin(people, eq(people.userId, profiles.userId))
    .where(eq(profiles.userId, userId))
    .limit(1);
  const [row] = options.forUpdate === true ? await query.for("update", { of: profiles }) : await query;
  if (row === undefined) throw new AppError("NOT_FOUND");
  return row;
}

/**
 * Map rows to the contract (avatar as a presigned 1 h URL).
 *
 * @param app - Storage and logger for the avatar URL.
 * @param record - Rows from {@link loadOwnProfile}.
 */
export async function toOwnProfile(app: AvatarUrlDeps, record: OwnProfileRecord): Promise<OwnProfile> {
  const { profile } = record;
  const own: OwnProfile = {
    userId: profile.userId,
    personId: record.personId,
    email: record.email,
    displayName: record.displayName,
    fullName: profile.fullName,
    familyBranch: profile.familyBranch,
    city: profile.city,
    phone: profile.phone,
    bio: profile.bio,
    avatarUrl: await avatarUrlFor(app, profile.avatarKey),
    visibility: {
      showEmail: profile.showEmail,
      showPhone: profile.showPhone,
      showCity: profile.showCity,
      listedInDirectory: profile.listedInDirectory
    },
    contacts: toOwnContacts(profile),
    updatedAt: profile.updatedAt.toISOString()
  };
  if (phoneNeedsConfirmation(profile.phone)) own.phoneNeedsConfirmation = true;
  return own;
}

/**
 * The owner's raw contacts plus the nine-key visibility read model (for editing).
 *
 * @param profile - The caller's own profile row.
 */
export function toOwnContacts(profile: ProfileRow): OwnContacts {
  return {
    whatsapp: profile.whatsapp,
    instagram: profile.instagram,
    facebook: profile.facebook,
    tiktok: profile.tiktok,
    linkedin: profile.linkedin,
    github: profile.github,
    website: profile.website,
    visibility: toContactVisibility(profile.showEmail, profile.showPhone, profile.contactVisibility)
  };
}

/**
 * WP-4.4 decision: a stored phone that is not E.164 (a legacy free-form value)
 * is never re-guessed; the owner is asked to confirm it instead.
 *
 * @param phone - `profiles.phone`.
 * @returns `true` when there is a phone and it is not E.164.
 */
export function phoneNeedsConfirmation(phone: string | null): boolean {
  return phone !== null && phone !== "" && !isE164(phone);
}

/** Profile columns `PATCH /api/profile/me/contacts` may write. */
type ContactsPatch = Partial<
  Pick<
    ProfileRow,
    | "phone"
    | "whatsapp"
    | "instagram"
    | "facebook"
    | "tiktok"
    | "linkedin"
    | "github"
    | "website"
    | "showEmail"
    | "showPhone"
    | "contactVisibility"
  >
>;

/**
 * The stored-visibility map with only known keys and boolean values. The
 * column CHECK already guarantees this; re-reading it fail-closed keeps a
 * merge from ever writing a key the CHECK would reject.
 *
 * @param stored - `profiles.contact_visibility` (untrusted jsonb).
 */
function sanitizeStoredVisibility(stored: unknown): StoredContactVisibility {
  const clean: StoredContactVisibility = {};
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return clean;
  const map: Record<string, unknown> = { ...stored };
  for (const key of STORED_CONTACT_VISIBILITY_KEYS) {
    const value = map[key];
    if (typeof value === "boolean") clean[key] = value;
  }
  return clean;
}

/**
 * Turn a validated contacts PATCH into profile columns. `visibility.email` and
 * `visibility.phone` write `show_email`/`show_phone` (the source of truth); the
 * other seven switches are merged into the stored `contact_visibility` map.
 * Values are already normalized by the contract (E.164, handles, https).
 * WhatsApp is stored exactly as sent; it is never inferred from the phone.
 *
 * @param input - Parsed `updateContactsInputSchema` output.
 * @param currentVisibility - The locked row's `contact_visibility`.
 * @returns The columns to write and the changed field names (for the audit; never values).
 */
export function buildContactsPatch(
  input: UpdateContactsInput,
  currentVisibility: unknown
): { patch: ContactsPatch; fields: string[] } {
  const patch: ContactsPatch = {};
  const fields: string[] = [];
  const valueKeys = ["phone", "whatsapp", "instagram", "facebook", "tiktok", "linkedin", "github", "website"] as const;
  for (const key of valueKeys) {
    const value = input[key];
    if (value !== undefined) {
      patch[key] = value;
      fields.push(key);
    }
  }
  const visibility = input.visibility;
  if (visibility !== undefined) {
    if (visibility.email !== undefined) patch.showEmail = visibility.email;
    if (visibility.phone !== undefined) patch.showPhone = visibility.phone;
    const merged = sanitizeStoredVisibility(currentVisibility);
    let storedChanged = false;
    for (const key of STORED_CONTACT_VISIBILITY_KEYS) {
      const value = visibility[key];
      if (value !== undefined) {
        merged[key] = value;
        storedChanged = true;
      }
    }
    if (storedChanged) patch.contactVisibility = merged;
    for (const key of Object.keys(visibility)) fields.push(`visibility.${key}`);
  }
  return { patch, fields: fields.sort() };
}

/** Profile columns a PATCH may write (never `userId`, `avatarKey`, timestamps). */
type ProfilePatch = Partial<
  Pick<
    ProfileRow,
    | "fullName"
    | "familyBranch"
    | "city"
    | "phone"
    | "bio"
    | "showEmail"
    | "showPhone"
    | "showCity"
    | "listedInDirectory"
  >
>;

/**
 * Split a validated PATCH into the `profiles` columns and the `users.display_name`
 * value. Built field by field from the strict contract schema, so nothing
 * outside the allowlist can reach the database.
 *
 * @param input - Parsed `updateProfileInputSchema` output.
 */
export function splitProfilePatch(input: UpdateProfileInput): {
  profile: ProfilePatch;
  displayName: string | undefined;
} {
  const profile: ProfilePatch = {};
  if (input.fullName !== undefined) profile.fullName = input.fullName;
  if (input.familyBranch !== undefined) profile.familyBranch = input.familyBranch;
  if (input.city !== undefined) profile.city = input.city;
  if (input.phone !== undefined) profile.phone = input.phone;
  if (input.bio !== undefined) profile.bio = input.bio;
  if (input.showEmail !== undefined) profile.showEmail = input.showEmail;
  if (input.showPhone !== undefined) profile.showPhone = input.showPhone;
  if (input.showCity !== undefined) profile.showCity = input.showCity;
  if (input.listedInDirectory !== undefined) profile.listedInDirectory = input.listedInDirectory;
  return { profile, displayName: input.displayName };
}
