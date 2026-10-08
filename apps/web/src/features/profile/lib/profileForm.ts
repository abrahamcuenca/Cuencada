/**
 * Form model for `/perfil`: values, dirty-field diff and validation.
 *
 * The page keeps only the fields the user edited ("edits") on top of the
 * server profile ("baseline"). The PATCH carries the fields whose normalised
 * value differs from the baseline, nothing else, and is validated with the
 * contract's `updateProfileInputSchema` (strict on the server: contract keys only).
 *
 * WP-4.4: the phone and the email/phone "Mostrar" switches moved to the
 * Contacto section (`contactForm.ts`, `PATCH /api/profile/me/contacts`).
 */
import { type OwnProfile, type UpdateProfileRequest, updateProfileInputSchema } from "@cuencada/types";

/** Text inputs of the form. */
export type ProfileTextField = "fullName" | "displayName" | "familyBranch" | "city" | "bio";

/** Switches of the privacy section (the `visibility` flags). */
export type ProfileSwitchField = "listedInDirectory" | "showCity";

/** Every editable field. */
export type ProfileField = ProfileTextField | ProfileSwitchField;

/** Values of the form, as the inputs hold them. */
export type ProfileFormValues = Record<ProfileTextField, string> & Record<ProfileSwitchField, boolean>;

/** Field errors keyed by field. */
export type ProfileFormErrors = Partial<Record<ProfileField, string>>;

/** Result of {@link buildProfilePatch}. */
export type ProfilePatchResult = { ok: true; patch: UpdateProfileRequest | null } | { ok: false; errors: ProfileFormErrors };

/** Text fields in form order; the first invalid one gets focus. */
export const PROFILE_TEXT_FIELDS: readonly ProfileTextField[] = ["fullName", "displayName", "familyBranch", "city", "bio"];

/** Switches in display order. */
export const PROFILE_SWITCH_FIELDS: readonly ProfileSwitchField[] = ["listedInDirectory", "showCity"];

const NULLABLE_TEXT: ReadonlySet<ProfileTextField> = new Set(["familyBranch", "city", "bio"]);

/**
 * @param profile - The server profile.
 * @returns The form values it corresponds to (`null` becomes "").
 */
export function toFormValues(profile: OwnProfile): ProfileFormValues {
  return {
    fullName: profile.fullName,
    displayName: profile.displayName,
    familyBranch: profile.familyBranch ?? "",
    city: profile.city ?? "",
    bio: profile.bio ?? "",
    listedInDirectory: profile.visibility.listedInDirectory,
    showCity: profile.visibility.showCity
  };
}

/**
 * Fields whose value differs from the baseline (the dirty fields). Text is
 * compared trimmed, so blank and surrounding spaces are not changes.
 *
 * @param baseline - Values from the server profile.
 * @param values - Current values (baseline plus the user's edits).
 * @returns The changed fields, in form order.
 */
export function dirtyFields(baseline: ProfileFormValues, values: ProfileFormValues): ProfileField[] {
  const changed: ProfileField[] = [];
  for (const field of PROFILE_TEXT_FIELDS) {
    if (values[field].trim() !== baseline[field].trim()) changed.push(field);
  }
  for (const field of PROFILE_SWITCH_FIELDS) {
    if (values[field] !== baseline[field]) changed.push(field);
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
 * @returns The patch (`null` when nothing changed) or the field errors.
 */
export function buildProfilePatch(baseline: ProfileFormValues, values: ProfileFormValues): ProfilePatchResult {
  const changed = dirtyFields(baseline, values);
  if (changed.length === 0) return { ok: true, patch: null };

  const body: Record<string, string | boolean | null> = {};
  for (const field of changed) {
    if (field === "listedInDirectory" || field === "showCity") {
      body[field] = values[field];
    } else {
      const value = values[field].trim();
      body[field] = NULLABLE_TEXT.has(field) && value === "" ? null : value;
    }
  }

  const parsed = updateProfileInputSchema.safeParse(body);
  if (parsed.success) return { ok: true, patch: parsed.data };

  const errors: ProfileFormErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && key in body) {
      // Safe: `key in body`, whose keys are all ProfileFields.
      const field = key as ProfileField;
      errors[field] ??= issue.message;
    }
  }
  return { ok: false, errors };
}
