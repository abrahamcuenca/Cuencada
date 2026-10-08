/**
 * Family tree. A `Person` is a tree node that may or may not have a user
 * account. Tree data is PII: member-only, never public.
 */
import { z } from "zod";
import {
  cursorQuerySchema,
  dateSchema,
  dateTimeSchema,
  displayTextSchema,
  idSchema,
  nullableDisplayTextSchema,
  nullableTextSchema
} from "./common.js";
import { type ContactCard, contactCardSchema } from "./contacts.js";
import {
  type AvatarUploadResponse,
  avatarConfirmInputSchema,
  avatarUploadInputSchema,
  avatarUploadResponseSchema,
  imageCropRectSchema
} from "./profile.js";

/**
 * Directed edge between two people. `parent_of`: from is a parent of to.
 * `partner_of`: symmetric; the server stores it with `fromPersonId < toPersonId`.
 */
export const RelationshipKind = {
  ParentOf: "parent_of",
  PartnerOf: "partner_of"
} as const;
export type RelationshipKind = (typeof RelationshipKind)[keyof typeof RelationshipKind];
export const relationshipKindSchema = z.enum(RelationshipKind);

/** Generations the tree view walks in each direction (raised from 3 in WP-4.0 for great-great-grandparents). */
export const FAMILY_TREE_MAX_DEPTH = 4;

/** Max length of `people.birthplace` (also its CHECK). */
export const PERSON_BIRTHPLACE_MAX_LENGTH = 120;
/** Max length of `people.bio` (also its CHECK). */
export const PERSON_BIO_MAX_LENGTH = 1000;

/** A person in the tree. */
export interface Person {
  id: string;
  /**
   * Linked account, or `null` for people without one (children, ancestors…).
   * Also `null` for other members when the linked account is not listed in
   * the directory (`listedInDirectory = false`); only that member and admins
   * see the link then.
   */
  userId: string | null;
  fullName: string;
  nickname: string | null;
  familyBranch: string | null;
  /**
   * `null` for **living** people unless the viewer is that person (linked
   * account) or an admin; deceased people always show it (when recorded).
   */
  birthYear: number | null;
  /** Only for deceased people. */
  deathYear: number | null;
  deceased: boolean;
  /**
   * Presigned photo URL (256 px on `Person`, 64 px on `PersonSummary`) or
   * `null`. Until WP-4.3 it is the linked profile's avatar only; from WP-4.3
   * it is the **resolved** photo: the linked account's own avatar wins, else
   * the tree photo (`people.photo_key`). `null` under the same unlisted rule as
   * `userId`, and for other members when the account is disabled (a tree
   * photo of a person without an account has no such rule).
   */
  avatarUrl: string | null;
  /**
   * Full birth date `YYYY-MM-DD` (WP-4.0). Same visibility as `birthYear`
   * (WP-4.1 widens "may see" to the viewer's qualifying own-family circle,
   * ADR 0001 §6, never to people reached through member-made edges between
   * existing people). Optional on
   * the wire so responses from servers before WP-4.1 still parse.
   */
  birthDate?: string | null;
  /** Full death date; only for deceased people. Optional on the wire (see `birthDate`). */
  deathDate?: string | null;
  /** Birthplace (≤ 120). Same visibility as `birthDate` for living people. Optional on the wire. */
  birthplace?: string | null;
  /** Short bio (≤ 1000), visible to verified members. Optional on the wire. */
  bio?: string | null;
}

export const personSchema = z.object({
  id: idSchema,
  userId: idSchema.nullable(),
  fullName: z.string().max(200),
  nickname: z.string().max(80).nullable(),
  familyBranch: z.string().max(120).nullable(),
  birthYear: z.number().int().nullable(),
  deathYear: z.number().int().nullable(),
  deceased: z.boolean(),
  avatarUrl: z.string().max(4096).nullable(),
  birthDate: dateSchema.nullable().exactOptional(),
  deathDate: dateSchema.nullable().exactOptional(),
  birthplace: z.string().max(PERSON_BIRTHPLACE_MAX_LENGTH).nullable().exactOptional(),
  bio: z.string().max(PERSON_BIO_MAX_LENGTH).nullable().exactOptional()
}) satisfies z.ZodType<Person>;

/** Where {@link PersonDetails.photoUrl} comes from. */
export const PersonPhotoSource = {
  /** The linked account's own avatar (always wins). */
  Avatar: "avatar",
  /** The tree photo uploaded for this person (`people.photo_key`). */
  Person: "person"
} as const;
export type PersonPhotoSource = (typeof PersonPhotoSource)[keyof typeof PersonPhotoSource];
export const personPhotoSourceSchema = z.enum(PersonPhotoSource);

/**
 * One person's full card (`GET /api/family/people/:id` from WP-4.1; a superset
 * of `Person`, so older clients still parse it): the tree "Detalles" accordion
 * and the person page. Every {@link Person} field is present (dates and texts
 * are `null` when hidden or empty). Built by WP-4.1 (permissions, privacy),
 * using `resolvePersonPhoto` (WP-4.3) and `personContactCard` (WP-4.4).
 */
export interface PersonDetails extends Person {
  birthDate: string | null;
  deathDate: string | null;
  birthplace: string | null;
  bio: string | null;
  /**
   * Resolved photo, server-side (`resolvePersonPhoto`): the linked account's
   * own avatar wins, else the person's tree photo, else `null`. 256 px (the
   * largest avatar derivative; WP-4.3 may serve 512 px for tree photos). Same
   * visibility rules as `avatarUrl`.
   */
  photoUrl: string | null;
  /** Which photo `photoUrl` is; `null` when there is none (or it is hidden). */
  photoSource: PersonPhotoSource | null;
  /**
   * The person has an account. For other members it follows the unlisted
   * rule of `userId` (`false` when the account is hidden from them).
   */
  isLinked: boolean;
  /**
   * The viewer may edit this person: admin, self, or in the viewer's
   * **qualifying** own-family circle (ADR 0001 §6) and not linked to another
   * account.
   */
  canEdit: boolean;
  /** The viewer may upload or remove the tree photo (admins, close relatives, or the person themself; WP-4.3). */
  canEditPhoto: boolean;
  /**
   * The linked account's visible contacts (`buildContactCard`, WP-4.4).
   * Empty for people without an account, unlisted or disabled accounts, and
   * when nothing is switched on.
   */
  contacts: ContactCard;
  /**
   * The viewer may add a **new** relative attached to this person
   * (`POST /api/family/people` with `relateTo.personId` = this person): admins,
   * or the person is in the viewer's qualifying circle (also when linked to
   * another account, which `canEdit` excludes). UX only; the server re-checks.
   * Optional on the wire (added by WP-4.1).
   */
  canAddRelative?: boolean;
  /**
   * The viewer may delete this person with `DELETE /api/family/people/:id`:
   * they created it, it has no account and no edges other than their own
   * (ADR 0001 §6). Always `false` for admins here (they use the admin route).
   * UX only; the server re-checks. Optional on the wire (added by WP-4.1).
   */
  canDelete?: boolean;
}

export const personDetailsSchema = personSchema.extend({
  birthDate: dateSchema.nullable(),
  deathDate: dateSchema.nullable(),
  birthplace: z.string().max(PERSON_BIRTHPLACE_MAX_LENGTH).nullable(),
  bio: z.string().max(PERSON_BIO_MAX_LENGTH).nullable(),
  photoUrl: z.string().max(4096).nullable(),
  photoSource: personPhotoSourceSchema.nullable(),
  isLinked: z.boolean(),
  canEdit: z.boolean(),
  canEditPhoto: z.boolean(),
  contacts: contactCardSchema,
  canAddRelative: z.boolean().exactOptional(),
  canDelete: z.boolean().exactOptional()
}) satisfies z.ZodType<PersonDetails>;

/** Lightweight node for rings and search results. */
export type PersonSummary = Pick<Person, "id" | "userId" | "fullName" | "nickname" | "deceased" | "avatarUrl">;

export const personSummarySchema = personSchema.pick({
  id: true,
  userId: true,
  fullName: true,
  nickname: true,
  deceased: true,
  avatarUrl: true
}) satisfies z.ZodType<PersonSummary>;

export interface Relationship {
  id: string;
  kind: RelationshipKind;
  fromPersonId: string;
  toPersonId: string;
}

export const relationshipSchema = z.object({
  id: idSchema,
  kind: relationshipKindSchema,
  fromPersonId: idSchema,
  toPersonId: idSchema
}) satisfies z.ZodType<Relationship>;

/**
 * Person-centred view (`GET /api/family/tree`). The first ring is always
 * filled; `extended` holds further generations when `depth > 1`, plus the
 * edges between all returned people so the client can lay them out.
 */
export interface FamilyTreeView {
  focus: Person;
  parents: PersonSummary[];
  partners: PersonSummary[];
  children: PersonSummary[];
  /** Full and half siblings (share at least one parent). */
  siblings: PersonSummary[];
  depth: number;
  extended: {
    people: PersonSummary[];
    relationships: Relationship[];
  };
}

export const familyTreeViewSchema = z.object({
  focus: personSchema,
  parents: z.array(personSummarySchema),
  partners: z.array(personSummarySchema),
  children: z.array(personSummarySchema),
  siblings: z.array(personSummarySchema),
  depth: z.number().int(),
  extended: z.object({
    people: z.array(personSummarySchema),
    relationships: z.array(relationshipSchema)
  })
}) satisfies z.ZodType<FamilyTreeView>;

/**
 * `GET /api/family/tree` query. Without `personId` the caller's own person is the focus.
 * `depth` above {@link FAMILY_TREE_MAX_DEPTH} is clamped to it (T6 amendment), not rejected.
 */
export const familyTreeQuerySchema = z.object({
  personId: idSchema.exactOptional(),
  depth: z.coerce
    .number<number | string>()
    .int()
    .min(1)
    .default(1)
    .transform((value) => Math.min(value, FAMILY_TREE_MAX_DEPTH))
});
export type FamilyTreeQuery = z.infer<typeof familyTreeQuerySchema>;
export type FamilyTreeQueryRequest = z.input<typeof familyTreeQuerySchema>;

/** `GET /api/family/people` query (search). */
export const peopleQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().max(100).exactOptional()
});
export type PeopleQuery = z.infer<typeof peopleQuerySchema>;
export type PeopleQueryRequest = z.input<typeof peopleQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

const yearValue = z.number().int().min(1800).max(2200);

/** A full person date: `YYYY-MM-DD` whose year is in the same 1800–2200 range as the year columns. */
const personDateValue = dateSchema.refine((value) => yearOf(value) >= 1800 && yearOf(value) <= 2200, {
  error: "La fecha debe estar entre 1800 y 2200."
});

// WP-4.1 removed the deprecated `createPersonInputSchema`/`updatePersonInputSchema`:
// the admin routes and form use `adminCreatePersonInputSchema`/`adminUpdatePersonInputSchema`.

/**
 * `POST /api/admin/relationships`. The server rejects self-references,
 * duplicates and `parent_of` cycles (409 `CONFLICT`).
 *
 * **Admin-only** (WP-4.0, Security M1): an edge between two *existing* people
 * can pull someone into a member's own-family circle, so members never create
 * or delete edges directly. A member's only way to add an edge is
 * `memberCreatePersonInputSchema.relateTo`, which attaches a person the member
 * creates in the same request.
 */
export const createRelationshipInputSchema = z
  .object({
    kind: relationshipKindSchema,
    fromPersonId: idSchema,
    toPersonId: idSchema
  })
  .refine((value) => value.fromPersonId !== value.toPersonId, {
    error: "Una persona no puede relacionarse consigo misma.",
    path: ["toPersonId"]
  });
export type CreateRelationshipInput = z.infer<typeof createRelationshipInputSchema>;
export type CreateRelationshipRequest = z.input<typeof createRelationshipInputSchema>;

/* -------------------------------------------------------------------------- */
/* WP-4.0: family editing by admins and members                                */
/* -------------------------------------------------------------------------- */

/**
 * Stable reasons on family 403/409 errors (`error.details[0].code`, the open
 * detail-code channel of ADR 0001 §4; `ErrorCode` itself stays closed).
 */
export const FamilyIssueCode = {
  /**
   * 403 `FORBIDDEN`: the target person (or `relateTo.personId`) is outside
   * the member's qualifying own-family circle (ADR 0001 §6).
   */
  NotInCircle: "FAMILY_NOT_IN_CIRCLE",
  /**
   * 403 `FORBIDDEN`: the person is linked to **another** account; only that
   * member or an admin may edit them. Also 409 `CONFLICT` on an invite for a
   * person that already has an account (WP-4.2).
   */
  PersonLinkedToOther: "PERSON_LINKED_TO_OTHER",
  /**
   * 409 `CONFLICT` on `DELETE /api/family/people/:id`: the person has edges
   * other than the one its creator added with it; only an admin may delete it.
   */
  PersonHasRelationships: "PERSON_HAS_RELATIONSHIPS",
  /** 403 `FORBIDDEN` on `DELETE /api/family/people/:id`: only the member who created the person (or an admin) may delete it. */
  NotCreator: "NOT_CREATOR",
  /**
   * 403 `FORBIDDEN` on `PATCH /api/family/people/:id` (WP-4.1, Security L2):
   * a member editing their **own linked** person sent `deceased`, `deathYear`
   * or `deathDate`; for linked people those are admin-only.
   */
  AdminOnlyField: "ADMIN_ONLY_FIELD"
} as const;

/**
 * Fields a member may never set on a person linked to an account (their own
 * node): marking someone dead is admin-only (WP-4.1, Security L2).
 */
export const LINKED_PERSON_ADMIN_ONLY_FIELDS = ["deceased", "deathYear", "deathDate"] as const;
export type FamilyIssueCode = (typeof FamilyIssueCode)[keyof typeof FamilyIssueCode];

/**
 * How a newly created person relates to an existing one (`relateTo.kind`),
 * read as "the **new** person is … of `personId`". Stored as a
 * {@link RelationshipKind} edge: `parent_of` → `new parent_of personId`,
 * `child_of` → `personId parent_of new`, `partner_of` → one `partner_of` edge.
 */
export const RelateKind = {
  ParentOf: "parent_of",
  ChildOf: "child_of",
  PartnerOf: "partner_of"
} as const;
export type RelateKind = (typeof RelateKind)[keyof typeof RelateKind];
export const relateKindSchema = z.enum(RelateKind);

/** The relationship created together with a new person (one transaction, same cycle/2-parent checks). */
export const relateToSchema = z.strictObject({
  personId: idSchema,
  kind: relateKindSchema
});
export type RelateTo = z.infer<typeof relateToSchema>;

/** Date and year fields of a person (any subset; `undefined` = not sent). */
export interface PersonDateFields {
  birthYear?: number | null | undefined;
  deathYear?: number | null | undefined;
  birthDate?: string | null | undefined;
  deathDate?: string | null | undefined;
  deceased?: boolean | undefined;
}

/** A person-date problem: the field to flag and a Spanish message. */
export interface PersonDateIssue {
  path: "birthYear" | "deathYear" | "birthDate" | "deathDate" | "deceased";
  message: string;
}

/** Year of a `YYYY-MM-DD` date. */
function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

const YEAR_MISMATCH = {
  birth: { path: "birthYear", message: "El año de nacimiento no coincide con la fecha." },
  death: { path: "deathYear", message: "El año de fallecimiento no coincide con la fecha." }
} as const satisfies Record<string, PersonDateIssue>;

/**
 * Checks the date/year rules on a **complete** row: a create after defaults,
 * or the stored row merged with a PATCH (the server must do the latter
 * before writing, to answer a Spanish 400 instead of a 500 from a CHECK).
 * Mirrors the database:
 *
 * - a full date requires its year, and falls in it (`people_birth_date_year_check`,
 *   `people_death_date_year_check`);
 * - death not before birth, for years and dates (`people_years_order_check`,
 *   `people_dates_order_check`);
 * - a death year or date requires `deceased` (`people_death_implies_deceased_check`;
 *   a death date always has its year, so the year check covers it).
 *
 * @param row - The merged values (missing = `null`, `deceased` missing = `false`).
 * @returns The first problem, or `null` when consistent.
 */
export function personDatesIssue(row: PersonDateFields): PersonDateIssue | null {
  const birthYear = row.birthYear ?? null;
  const deathYear = row.deathYear ?? null;
  const birthDate = row.birthDate ?? null;
  const deathDate = row.deathDate ?? null;
  if (birthDate !== null && birthYear !== yearOf(birthDate)) return YEAR_MISMATCH.birth;
  if (deathDate !== null && deathYear !== yearOf(deathDate)) return YEAR_MISMATCH.death;
  if (birthYear !== null && deathYear !== null && deathYear < birthYear) {
    return { path: "deathYear", message: "El año de fallecimiento no puede ser anterior al de nacimiento." };
  }
  if (birthDate !== null && deathDate !== null && deathDate < birthDate) {
    return { path: "deathDate", message: "La fecha de fallecimiento no puede ser anterior a la de nacimiento." };
  }
  if ((deathYear !== null || deathDate !== null) && row.deceased !== true) {
    return { path: "deceased", message: "Marca «Ya falleció» para registrar el fallecimiento." };
  }
  return null;
}

/**
 * Checks only the pairs a PATCH carries itself (the merged row is checked by
 * the server with {@link personDatesIssue}). Runs after {@link deriveDateFields}.
 */
function patchDatesIssue(patch: PersonDateFields): PersonDateIssue | null {
  if (typeof patch.birthDate === "string" && patch.birthYear !== undefined && patch.birthYear !== yearOf(patch.birthDate)) {
    return YEAR_MISMATCH.birth;
  }
  if (typeof patch.deathDate === "string" && patch.deathYear !== undefined && patch.deathYear !== yearOf(patch.deathDate)) {
    return YEAR_MISMATCH.death;
  }
  const pair = personDatesIssue({
    birthYear: patch.birthYear ?? null,
    deathYear: patch.deathYear ?? null,
    birthDate: typeof patch.birthYear === "number" ? (patch.birthDate ?? null) : null,
    deathDate: typeof patch.deathYear === "number" ? (patch.deathDate ?? null) : null,
    deceased: patch.deceased !== false
  });
  return pair;
}

/** Fields derived from the sent ones, see {@link deriveDateFields}. */
type DerivedDateFields = Pick<PersonDateFields, "birthYear" | "deathYear" | "deceased">;

/**
 * Date/year rule (WP-4.0 decision): **the year follows the date**. A full date
 * sent without its year fills the year; when both are sent they must agree.
 * A death year or date sent without `deceased` sets `deceased: true`. Only
 * keys that are filled in appear in the result (a PATCH never gains keys
 * it did not imply).
 */
function deriveDateFields(value: PersonDateFields): DerivedDateFields {
  const derived: DerivedDateFields = {};
  if (typeof value.birthDate === "string" && value.birthYear === undefined) derived.birthYear = yearOf(value.birthDate);
  if (typeof value.deathDate === "string" && value.deathYear === undefined) derived.deathYear = yearOf(value.deathDate);
  const dies = typeof (value.deathYear ?? derived.deathYear) === "number" || typeof value.deathDate === "string";
  if (dies && value.deceased === undefined) derived.deceased = true;
  return derived;
}

function toIssue(ctx: z.RefinementCtx, issue: PersonDateIssue | null): void {
  if (issue !== null) ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
}

/** Person fields shared by the WP-4 inputs (no defaults: a PATCH never resets omitted fields). */
const personWriteFields = {
  fullName: displayTextSchema(200),
  nickname: nullableDisplayTextSchema(80),
  familyBranch: nullableTextSchema(120),
  birthYear: yearValue.nullable(),
  deathYear: yearValue.nullable(),
  birthDate: personDateValue.nullable(),
  deathDate: personDateValue.nullable(),
  birthplace: nullableDisplayTextSchema(PERSON_BIRTHPLACE_MAX_LENGTH),
  bio: nullableTextSchema(PERSON_BIO_MAX_LENGTH),
  deceased: z.boolean()
};

/** Create-only defaults; years and `deceased` default after derivation (see {@link completeCreate}). */
const personCreateFields = {
  ...personWriteFields,
  nickname: nullableDisplayTextSchema(80).default(null),
  familyBranch: nullableTextSchema(120).default(null),
  birthYear: yearValue.nullable().optional(),
  deathYear: yearValue.nullable().optional(),
  birthDate: personDateValue.nullable().default(null),
  deathDate: personDateValue.nullable().default(null),
  birthplace: nullableDisplayTextSchema(PERSON_BIRTHPLACE_MAX_LENGTH).default(null),
  bio: nullableTextSchema(PERSON_BIO_MAX_LENGTH).default(null),
  deceased: z.boolean().optional()
};

/** A complete create row: years and `deceased` are always set. */
interface CompletedDates {
  birthYear: number | null;
  deathYear: number | null;
  deceased: boolean;
}

function completeCreate<TValue extends PersonDateFields>(value: TValue): Omit<TValue, keyof CompletedDates> & CompletedDates {
  const derived = deriveDateFields(value);
  return {
    ...value,
    birthYear: value.birthYear ?? derived.birthYear ?? null,
    deathYear: value.deathYear ?? derived.deathYear ?? null,
    deceased: value.deceased ?? derived.deceased ?? false
  };
}

/**
 * `POST /api/admin/people` (WP-4.1; supersedes `createPersonInputSchema`).
 * Admins may create anyone, optionally linked to an account (`userId`) and
 * optionally related to an existing person (`relateTo`, default `null`).
 */
export const adminCreatePersonInputSchema = z
  .strictObject({
    ...personCreateFields,
    userId: idSchema.nullable().default(null),
    relateTo: relateToSchema.nullable().default(null)
  })
  .transform(completeCreate)
  .superRefine((value, ctx) => toIssue(ctx, personDatesIssue(value)));
export type AdminCreatePersonInput = z.infer<typeof adminCreatePersonInputSchema>;
export type AdminCreatePersonRequest = z.input<typeof adminCreatePersonInputSchema>;

/**
 * `POST /api/family/people` (WP-4.1): a member adds a **new** relative. `relateTo`
 * is **required** and its `personId` must already be in the member's
 * qualifying own-family circle (403 `FAMILY_NOT_IN_CIRCLE`; ADR 0001 §6). The
 * person and the edge are created in one transaction, and the edge is marked
 * member-created (`person_relationships.created_by_member`). This is the
 * **only** member path that creates an edge: members never relate two existing
 * people (Security M1). Members never link accounts: `userId` is not accepted
 * (strict object → 400).
 */
export const memberCreatePersonInputSchema = z
  .strictObject({
    ...personCreateFields,
    relateTo: relateToSchema
  })
  .transform(completeCreate)
  .superRefine((value, ctx) => toIssue(ctx, personDatesIssue(value)));
export type MemberCreatePersonInput = z.infer<typeof memberCreatePersonInputSchema>;
export type MemberCreatePersonRequest = z.input<typeof memberCreatePersonInputSchema>;

const noChanges = { error: "No hay cambios que guardar." };

/**
 * `PATCH /api/admin/people/:id` (WP-4.1; supersedes
 * `updatePersonInputSchema`). Partial, no defaults. A date without its year
 * fills the year; a death without `deceased` sets it. The server must then
 * re-check the **merged** row with {@link personDatesIssue} (e.g. a new
 * `birthYear` against a stored `birthDate`).
 */
export const adminUpdatePersonInputSchema = z
  .strictObject({ ...personWriteFields, userId: idSchema.nullable() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, noChanges)
  .transform((value) => ({ ...value, ...deriveDateFields(value) }))
  .superRefine((value, ctx) => toIssue(ctx, patchDatesIssue(value)));
export type AdminUpdatePersonInput = z.infer<typeof adminUpdatePersonInputSchema>;
export type AdminUpdatePersonRequest = z.input<typeof adminUpdatePersonInputSchema>;

/**
 * `PATCH /api/family/people/:id` (WP-4.1): a member edits someone in their
 * circle, or themself. Same rules as the admin patch, without `userId`
 * (strict: 400). People linked to **another** account answer 403
 * `PERSON_LINKED_TO_OTHER`.
 */
export const memberUpdatePersonInputSchema = z
  .strictObject(personWriteFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, noChanges)
  .transform((value) => ({ ...value, ...deriveDateFields(value) }))
  .superRefine((value, ctx) => toIssue(ctx, patchDatesIssue(value)));
export type MemberUpdatePersonInput = z.infer<typeof memberUpdatePersonInputSchema>;
export type MemberUpdatePersonRequest = z.input<typeof memberUpdatePersonInputSchema>;

/**
 * `PATCH /api/family/me` (alias `PATCH /api/family/people/me`): a member edits
 * their *own* linked person. Same field set a member may change on their own
 * node through `PATCH /api/family/people/:id` (WP-4.1, Security L2): name,
 * nickname, branch, birth year/date, birthplace and bio. Death data
 * (`deceased`, `deathYear`, `deathDate`), `userId` and relationships are
 * admin-only; this legacy route **strips** unknown keys (older clients),
 * while `PATCH /api/family/people/:id` answers 403 `ADMIN_ONLY_FIELD`.
 */
export const selfEditPersonInputSchema = z
  .object({
    fullName: personWriteFields.fullName,
    nickname: personWriteFields.nickname,
    familyBranch: personWriteFields.familyBranch,
    birthYear: personWriteFields.birthYear,
    birthDate: personWriteFields.birthDate,
    birthplace: personWriteFields.birthplace,
    bio: personWriteFields.bio
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, noChanges)
  .transform((value) => ({ ...value, ...deriveDateFields(value) }))
  .superRefine((value, ctx) => toIssue(ctx, patchDatesIssue(value)));
export type SelfEditPersonInput = z.infer<typeof selfEditPersonInputSchema>;
export type SelfEditPersonRequest = z.input<typeof selfEditPersonInputSchema>;

/* -------------------------------------------------------------------------- */
/* Revisions (admin-only undo history)                                         */
/* -------------------------------------------------------------------------- */

/** What a revision recorded (`person_revisions.action`, CHECK in migration 0004). */
export const PersonRevisionAction = {
  PersonCreate: "person.create",
  PersonUpdate: "person.update",
  PersonDelete: "person.delete",
  RelationshipCreate: "relationship.create",
  RelationshipDelete: "relationship.delete",
  PersonPhoto: "person.photo",
  PersonRevert: "person.revert"
} as const;
export type PersonRevisionAction = (typeof PersonRevisionAction)[keyof typeof PersonRevisionAction];
export const personRevisionActionSchema = z.enum(PersonRevisionAction);

/**
 * Every snapshot carries `personId` (Security L2): the person the revision is
 * about, kept even after the person row is deleted (`person_revisions.person_id`
 * becomes `null`). The DB requires the key (`person_revisions_snapshots_check`),
 * so a removal request can find and purge all history about someone.
 */
interface PersonRevisionSnapshotBase {
  /** The person this history entry is about (for a relationship: the person the change was made from, e.g. the new relative). */
  personId: string;
}

/** Snapshot of a person's editable columns (`before`/`after` of person actions). `id` = `personId`. */
export interface PersonRevisionPersonSnapshot extends PersonRevisionSnapshotBase {
  type: "person";
  id: string;
  userId: string | null;
  fullName: string;
  nickname: string | null;
  familyBranch: string | null;
  birthYear: number | null;
  deathYear: number | null;
  birthDate: string | null;
  deathDate: string | null;
  birthplace: string | null;
  bio: string | null;
  deceased: boolean;
}

/** Snapshot of a relationship (`after` of a create, `before` of a delete). */
export interface PersonRevisionRelationshipSnapshot extends PersonRevisionSnapshotBase {
  type: "relationship";
  id: string;
  kind: RelationshipKind;
  fromPersonId: string;
  toPersonId: string;
}

/**
 * Snapshot of a photo change: only whether there was a photo and when.
 * Object keys are never exposed, and replaced photo objects are deleted, so
 * `person.photo` revisions are **not** revertible.
 */
export interface PersonRevisionPhotoSnapshot extends PersonRevisionSnapshotBase {
  type: "photo";
  /** Same as `personId`. */
  id: string;
  hasPhoto: boolean;
  photoUpdatedAt: string | null;
}

/** `person_revisions.before`/`after` (jsonb), discriminated by `type`. */
export type PersonRevisionSnapshot =
  | PersonRevisionPersonSnapshot
  | PersonRevisionRelationshipSnapshot
  | PersonRevisionPhotoSnapshot;

export const personRevisionSnapshotSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("person"),
    personId: idSchema,
    id: idSchema,
    userId: idSchema.nullable(),
    fullName: z.string().max(200),
    nickname: z.string().max(80).nullable(),
    familyBranch: z.string().max(120).nullable(),
    birthYear: z.number().int().nullable(),
    deathYear: z.number().int().nullable(),
    birthDate: dateSchema.nullable(),
    deathDate: dateSchema.nullable(),
    birthplace: z.string().max(PERSON_BIRTHPLACE_MAX_LENGTH).nullable(),
    bio: z.string().max(PERSON_BIO_MAX_LENGTH).nullable(),
    deceased: z.boolean()
  }),
  z.object({
    type: z.literal("relationship"),
    personId: idSchema,
    id: idSchema,
    kind: relationshipKindSchema,
    fromPersonId: idSchema,
    toPersonId: idSchema
  }),
  z.object({
    type: z.literal("photo"),
    personId: idSchema,
    id: idSchema,
    hasPhoto: z.boolean(),
    photoUpdatedAt: dateTimeSchema.nullable()
  })
]) satisfies z.ZodType<PersonRevisionSnapshot>;

/**
 * One entry of the admin "Historial" (`GET /api/admin/people/:id/revisions`).
 * **Admin-only**: `before`/`after` hold PII (dates, birthplace, bio). Rows are
 * kept one year (cleanup job, WP-4.1).
 */
export interface PersonRevision {
  id: string;
  /** `null` once the person is deleted (FK `ON DELETE SET NULL`); the snapshots keep the id. */
  personId: string | null;
  /** Set for `relationship.*` actions (no FK: the edge may be gone). */
  relationshipId: string | null;
  action: PersonRevisionAction;
  /** Who made the change; `null` when the account was deleted. */
  actor: { userId: string; displayName: string } | null;
  before: PersonRevisionSnapshot | null;
  after: PersonRevisionSnapshot | null;
  /** The `person.revert` revision that undid this one, if any. */
  revertedByRevisionId: string | null;
  /** "Deshacer" is offered: not yet reverted, not a photo or revert action. The server re-checks on revert. */
  revertible: boolean;
  createdAt: string;
}

export const personRevisionSchema = z.object({
  id: idSchema,
  personId: idSchema.nullable(),
  relationshipId: idSchema.nullable(),
  action: personRevisionActionSchema,
  actor: z.object({ userId: idSchema, displayName: z.string().max(80) }).nullable(),
  before: personRevisionSnapshotSchema.nullable(),
  after: personRevisionSnapshotSchema.nullable(),
  revertedByRevisionId: idSchema.nullable(),
  revertible: z.boolean(),
  createdAt: dateTimeSchema
}) satisfies z.ZodType<PersonRevision>;

/** `GET /api/admin/people/:id/revisions` query (`:id` = person): newest first, cursor-paged. */
export const personRevisionsQuerySchema = cursorQuerySchema;
export type PersonRevisionsQuery = z.infer<typeof personRevisionsQuerySchema>;
export type PersonRevisionsQueryRequest = z.input<typeof personRevisionsQuerySchema>;

/**
 * Path params of `POST /api/admin/revisions/:revisionId/revert` ("Deshacer";
 * no body): restores `before` (or removes/re-adds the relationship) in one
 * transaction and records a `person.revert` revision that points back
 * through `revertedByRevisionId`. 409 `CONFLICT` when it was already reverted
 * or no longer applies.
 */
export const revertPersonRevisionInputSchema = z.strictObject({ revisionId: idSchema });
export type RevertPersonRevisionInput = z.infer<typeof revertPersonRevisionInputSchema>;
export type RevertPersonRevisionRequest = z.input<typeof revertPersonRevisionInputSchema>;

/**
 * Body of `POST /api/admin/people/:id/revisions/purge` (**admin-only**,
 * WP-4.1; Security L2). `:id` is the person (`idParamSchema`), which may
 * already be deleted. Erases every revision about that person for a removal
 * request: rows whose `person_id` is it, or whose `before`/`after` snapshot
 * has it as `personId`, `fromPersonId` or `toPersonId`. Audited (ids and the
 * count only). `confirm` must be literally `true` so a stray call cannot wipe
 * history.
 */
export const purgePersonRevisionsInputSchema = z.strictObject({
  confirm: z.literal(true, { error: "Confirma que quieres borrar el historial." })
});
export type PurgePersonRevisionsInput = z.infer<typeof purgePersonRevisionsInputSchema>;
export type PurgePersonRevisionsRequest = z.input<typeof purgePersonRevisionsInputSchema>;

/** Response of the purge: how many revisions were deleted. */
export interface PurgePersonRevisionsResponse {
  deleted: number;
}
export const purgePersonRevisionsResponseSchema = z.object({
  deleted: z.number().int().min(0)
}) satisfies z.ZodType<PurgePersonRevisionsResponse>;

/**
 * Query of `DELETE /api/admin/people/:id` (WP-4.1). `purgeHistory=true`
 * ("Borrar también el historial") erases every revision about the person in
 * the same transaction, **before** the delete, and the delete itself then
 * records no revision (a removal request leaves no snapshot behind).
 */
export const adminDeletePersonQuerySchema = z.object({
  purgeHistory: z.stringbool().default(false)
});
export type AdminDeletePersonQuery = z.infer<typeof adminDeletePersonQuerySchema>;
export type AdminDeletePersonQueryRequest = z.input<typeof adminDeletePersonQuerySchema>;

/**
 * One row of the global admin feed "Actividad del árbol"
 * (`GET /api/admin/family/activity`, WP-4.1): a {@link PersonRevision} plus
 * the person's display name (current name, or the name in the snapshot once
 * the person is deleted). **Admin-only** (PII).
 */
export interface FamilyActivityItem extends PersonRevision {
  personName: string | null;
}

export const familyActivityItemSchema = personRevisionSchema.extend({
  personName: z.string().max(200).nullable()
}) satisfies z.ZodType<FamilyActivityItem>;

/**
 * `GET /api/admin/family/activity` query: newest first, keyset-paginated
 * (`cursor` is opaque and carries no PII), optionally filtered by who made
 * the change and by action.
 */
export const familyActivityQuerySchema = cursorQuerySchema.extend({
  actorUserId: idSchema.exactOptional(),
  action: personRevisionActionSchema.exactOptional()
});
export type FamilyActivityQuery = z.infer<typeof familyActivityQuerySchema>;
export type FamilyActivityQueryRequest = z.input<typeof familyActivityQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Person photos (WP-4.3)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/family/people/:id/photo/uploads`: same body and limits as the
 * avatar upload intent (JPEG/PNG/WebP, ≤ 10 MB). The object key is generated
 * server-side.
 */
export const personPhotoUploadInputSchema = avatarUploadInputSchema;
export type PersonPhotoUploadInput = z.infer<typeof personPhotoUploadInputSchema>;
export type PersonPhotoUploadRequest = z.input<typeof personPhotoUploadInputSchema>;

/** Presigned PUT for a person photo (same shape as the avatar one). */
export type PersonPhotoUploadResponse = AvatarUploadResponse;
export const personPhotoUploadResponseSchema = avatarUploadResponseSchema;

/**
 * `POST /api/family/people/:id/photo/confirm`; responds with the updated
 * {@link PersonDetails}. `crop` is optional: the web crops client-side and
 * omits it. When sent, the server clamps it to the decoded image with
 * `clampCropRect` before `extract()`, then resizes as for avatars.
 */
export const personPhotoConfirmInputSchema = avatarConfirmInputSchema.extend({
  crop: imageCropRectSchema.exactOptional()
});
export type PersonPhotoConfirmInput = z.infer<typeof personPhotoConfirmInputSchema>;
export type PersonPhotoConfirmRequest = z.input<typeof personPhotoConfirmInputSchema>;
