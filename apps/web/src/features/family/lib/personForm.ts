/**
 * Form state for a person's data (WP-4.1): name, nickname, branch, birth and
 * death as a year **or** a full date, "Ya falleció", birthplace and bio.
 * Shared by the add-relative sheet, the edit sheet and the admin editor.
 *
 * Date rule (ADR 0001 §6, "the year follows the date"): a full date fills
 * its year; **clearing a year clears its date**, and so does changing the
 * year to one the date is not in.
 */
import type { Person } from "@cuencada/types";
import { toNullableText, toNullableYear } from "./forms";

/** Field values as typed (strings), plus the checkbox. */
export interface PersonFormValues {
  fullName: string;
  nickname: string;
  familyBranch: string;
  birthYear: string;
  birthDate: string;
  deathYear: string;
  deathDate: string;
  deceased: boolean;
  birthplace: string;
  bio: string;
}

/** Text fields of {@link PersonFormValues}. */
export type PersonTextField = Exclude<keyof PersonFormValues, "deceased">;

/** Every field name the person forms map errors to. */
export const PERSON_FIELD_NAMES = [
  "fullName",
  "nickname",
  "familyBranch",
  "birthYear",
  "birthDate",
  "deathYear",
  "deathDate",
  "deceased",
  "birthplace",
  "bio"
] as const;

/**
 * @param fullName - Pre-fill (e.g. what the admin typed in the search).
 * @returns An empty form.
 */
export function emptyPersonValues(fullName = ""): PersonFormValues {
  return {
    fullName,
    nickname: "",
    familyBranch: "",
    birthYear: "",
    birthDate: "",
    deathYear: "",
    deathDate: "",
    deceased: false,
    birthplace: "",
    bio: ""
  };
}

const text = (value: string | null | undefined): string => value ?? "";
const year = (value: number | null | undefined): string => (value === null || value === undefined ? "" : String(value));

/**
 * @param person - A stored person (fields the viewer may not see are `null`).
 * @returns The form pre-filled with it.
 */
export function personValues(person: Person): PersonFormValues {
  return {
    fullName: person.fullName,
    nickname: text(person.nickname),
    familyBranch: text(person.familyBranch),
    birthYear: year(person.birthYear),
    birthDate: text(person.birthDate),
    deathYear: year(person.deathYear),
    deathDate: text(person.deathDate),
    deceased: person.deceased,
    birthplace: text(person.birthplace),
    bio: text(person.bio)
  };
}

/**
 * Apply one text edit, keeping year and date consistent: a date fills its
 * year; a cleared (or different) year clears its date.
 *
 * @param values - Current values.
 * @param field - The edited field.
 * @param value - The new text.
 * @returns The next values.
 */
export function editPersonField(values: PersonFormValues, field: PersonTextField, value: string): PersonFormValues {
  const next = { ...values, [field]: value };
  if (field === "birthDate" && /^\d{4}-/.test(value)) next.birthYear = value.slice(0, 4);
  if (field === "deathDate" && /^\d{4}-/.test(value)) next.deathYear = value.slice(0, 4);
  if (field === "birthYear" && values.birthDate !== "" && value.trim() !== values.birthDate.slice(0, 4)) next.birthDate = "";
  if (field === "deathYear" && values.deathDate !== "" && value.trim() !== values.deathDate.slice(0, 4)) next.deathDate = "";
  return next;
}

/**
 * Toggle "Ya falleció"; un-ticking it clears the death year and date (a
 * living person has none).
 */
export function setDeceased(values: PersonFormValues, deceased: boolean): PersonFormValues {
  return deceased ? { ...values, deceased } : { ...values, deceased, deathYear: "", deathDate: "" };
}

/** The person fields as the create/update contracts take them. */
export interface PersonFieldsBody {
  fullName: string;
  nickname: string | null;
  familyBranch: string | null;
  birthYear: number | null;
  birthDate: string | null;
  deathYear: number | null;
  deathDate: string | null;
  deceased: boolean;
  birthplace: string | null;
  bio: string | null;
}

/**
 * @param values - The form.
 * @returns Every field, converted (blank → `null`; a malformed year → `NaN` for the schema to report).
 */
export function toPersonFields(values: PersonFormValues): PersonFieldsBody {
  const deathYear = values.deceased ? toNullableYear(values.deathYear) : null;
  const deathDate = values.deceased ? toNullableText(values.deathDate) : null;
  return {
    fullName: values.fullName.trim(),
    nickname: toNullableText(values.nickname),
    familyBranch: toNullableText(values.familyBranch),
    birthYear: toNullableYear(values.birthYear),
    birthDate: toNullableText(values.birthDate),
    deathYear,
    deathDate,
    deceased: values.deceased,
    birthplace: toNullableText(values.birthplace),
    bio: toNullableText(values.bio)
  };
}

/**
 * Only the fields that changed, so two people editing different fields
 * don't overwrite each other.
 *
 * @param person - The stored person.
 * @param values - The form.
 * @returns The PATCH body (may be empty).
 */
export function changedPersonFields(person: Person, values: PersonFormValues): Partial<PersonFieldsBody> {
  const full = toPersonFields(values);
  const stored: PersonFieldsBody = {
    fullName: person.fullName,
    nickname: person.nickname,
    familyBranch: person.familyBranch,
    birthYear: person.birthYear,
    birthDate: person.birthDate ?? null,
    deathYear: person.deathYear,
    deathDate: person.deathDate ?? null,
    deceased: person.deceased,
    birthplace: person.birthplace ?? null,
    bio: person.bio ?? null
  };
  const patch: Partial<PersonFieldsBody> = {};
  for (const key of Object.keys(full) as Array<keyof PersonFieldsBody>) {
    // Object.keys of a literal of this exact type: every key is a PersonFieldsBody key.
    if (!Object.is(full[key], stored[key])) Object.assign(patch, { [key]: full[key] });
  }
  return patch;
}
