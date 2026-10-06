/**
 * Form model for `/perfil`: values, dirty-field diff and validation.
 *
 * The page keeps only the fields the user edited ("edits") on top of the
 * server profile ("baseline"). The PATCH carries the fields whose normalised
 * value differs from the baseline, nothing else, and is validated with the
 * contract's `updateProfileInputSchema`.
 *
 * "Aparecer en el directorio" (`visibility.listedInDirectory`) is being added
 * to the contract by migration 0002 (WP-2.1). Until that merges it is read as
 * an optional field: the switch is shown only when the server's profile
 * carries it, so the form never sends a field the API does not know.
 * TODO(WP-2.1): use the contract field once `origin/wp/2.1-migration-0002` is merged.
 */
import { type OwnProfile, type UpdateProfileRequest, updateProfileInputSchema } from "@cuencada/types";

/** The profile as the page reads it: the contract plus the pending `listedInDirectory`. */
export type ProfileWithListing = OwnProfile & {
  visibility: OwnProfile["visibility"] & { listedInDirectory?: boolean };
};

/** Text inputs of the form. */
export type ProfileTextField = "fullName" | "displayName" | "familyBranch" | "city" | "phone" | "bio";

/** Switches of the privacy section. */
export type ProfileSwitchField = "listedInDirectory" | "showEmail" | "showPhone" | "showCity";

/** Every editable field. */
export type ProfileField = ProfileTextField | ProfileSwitchField;

/** Values of the form, as the inputs hold them. */
export type ProfileFormValues = Record<ProfileTextField, string> & Record<ProfileSwitchField, boolean>;

/** Which pending contract fields the server already supports. */
export interface ProfileSupport {
  listedInDirectory: boolean;
}

/** `PATCH /profile/me` body: the contract fields plus `listedInDirectory` once supported. */
export type ProfilePatch = UpdateProfileRequest & { listedInDirectory?: boolean };

/** Field errors keyed by field. */
export type ProfileFormErrors = Partial<Record<ProfileField, string>>;

/** Result of {@link buildProfilePatch}. */
export type ProfilePatchResult = { ok: true; patch: ProfilePatch | null } | { ok: false; errors: ProfileFormErrors };

/** Text fields in form order; the first invalid one gets focus. */
export const PROFILE_TEXT_FIELDS: readonly ProfileTextField[] = ["fullName", "displayName", "familyBranch", "city", "phone", "bio"];

/** Switches in display order. */
export const PROFILE_SWITCH_FIELDS: readonly ProfileSwitchField[] = ["listedInDirectory", "showEmail", "showPhone", "showCity"];

const NULLABLE_TEXT: ReadonlySet<ProfileTextField> = new Set(["familyBranch", "city", "phone", "bio"]);

/**
 * @param profile - The server profile.
 * @returns Which pending fields the server already sends.
 */
export function detectSupport(profile: ProfileWithListing): ProfileSupport {
  return { listedInDirectory: typeof profile.visibility.listedInDirectory === "boolean" };
}

/**
 * @param field - A form field.
 * @param support - What the server supports.
 * @returns Whether the field is shown and can be sent.
 */
export function isFieldSupported(field: ProfileField, support: ProfileSupport): boolean {
  return field === "listedInDirectory" ? support.listedInDirectory : true;
}

/**
 * @param profile - The server profile.
 * @returns The form values it corresponds to (`null` becomes "").
 */
export function toFormValues(profile: ProfileWithListing): ProfileFormValues {
  return {
    fullName: profile.fullName,
    displayName: profile.displayName,
    familyBranch: profile.familyBranch ?? "",
    city: profile.city ?? "",
    phone: profile.phone ?? "",
    bio: profile.bio ?? "",
    listedInDirectory: profile.visibility.listedInDirectory ?? true,
    showEmail: profile.visibility.showEmail,
    showPhone: profile.visibility.showPhone,
    showCity: profile.visibility.showCity
  };
}

/**
 * Fields whose value differs from the baseline (the dirty fields). Text is
 * compared trimmed, so blank and surrounding spaces are not changes.
 *
 * @param baseline - Values from the server profile.
 * @param values - Current values (baseline plus the user's edits).
 * @param support - What the server supports.
 * @returns The changed fields, in form order.
 */
export function dirtyFields(baseline: ProfileFormValues, values: ProfileFormValues, support: ProfileSupport): ProfileField[] {
  const changed: ProfileField[] = [];
  for (const field of PROFILE_TEXT_FIELDS) {
    if (values[field].trim() !== baseline[field].trim()) changed.push(field);
  }
  for (const field of PROFILE_SWITCH_FIELDS) {
    if (isFieldSupported(field, support) && values[field] !== baseline[field]) changed.push(field);
  }
  return changed;
}

/**
 * Builds the PATCH body from the dirty fields and validates it with the
 * contract schema (Spanish messages). Untouched fields are neither sent nor
 * validated, so an old server value can't block saving something else.
 *
 * @param baseline - Values from the server profile.
 * @param values - Current values.
 * @param support - What the server supports.
 * @returns The patch (`null` when nothing changed) or the field errors.
 */
export function buildProfilePatch(baseline: ProfileFormValues, values: ProfileFormValues, support: ProfileSupport): ProfilePatchResult {
  const changed = dirtyFields(baseline, values, support);
  if (changed.length === 0) return { ok: true, patch: null };

  const contractBody: Record<string, string | boolean | null> = {};
  let listedInDirectory: boolean | undefined;
  for (const field of changed) {
    if (field === "listedInDirectory") {
      listedInDirectory = values.listedInDirectory;
    } else if (field === "showEmail" || field === "showPhone" || field === "showCity") {
      contractBody[field] = values[field];
    } else {
      const value = values[field].trim();
      contractBody[field] = NULLABLE_TEXT.has(field) && value === "" ? null : value;
    }
  }

  const patch: ProfilePatch = {};
  if (Object.keys(contractBody).length > 0) {
    const parsed = updateProfileInputSchema.safeParse(contractBody);
    if (!parsed.success) {
      const errors: ProfileFormErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && key in contractBody) {
          // Safe: `key in contractBody`, whose keys are all ProfileFields.
          const field = key as ProfileField;
          errors[field] ??= issue.message;
        }
      }
      return { ok: false, errors };
    }
    Object.assign(patch, parsed.data);
  }
  if (listedInDirectory !== undefined) patch.listedInDirectory = listedInDirectory;
  return { ok: true, patch };
}
