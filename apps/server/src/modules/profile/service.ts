/**
 * Own-profile reads and writes. The caller's profile row is created lazily
 * (full name = display name) if an account somehow has none.
 */
import type { OwnProfile, UpdateProfileInput } from "@cuencada/types";
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
  return {
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
      showCity: profile.showCity
      // WP-2.1: listedInDirectory: profile.listedInDirectory
    },
    updatedAt: profile.updatedAt.toISOString()
  };
}

/** Profile columns a PATCH may write (never `userId`, `avatarKey`, timestamps). WP-2.1 adds `listedInDirectory`. */
type ProfilePatch = Partial<
  Pick<ProfileRow, "fullName" | "familyBranch" | "city" | "phone" | "bio" | "showEmail" | "showPhone" | "showCity">
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
  // WP-2.1: `if (input.listedInDirectory !== undefined) profile.listedInDirectory = input.listedInDirectory;`
  return { profile, displayName: input.displayName };
}
