/**
 * Family tree. A `Person` is a tree node that may or may not have a user
 * account. Tree data is PII: member-only, never public.
 */
import { z } from "zod";
import { cursorQuerySchema, displayTextSchema, idSchema, nullableDisplayTextSchema, nullableTextSchema } from "./common.js";

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

export const FAMILY_TREE_MAX_DEPTH = 3;

/** A person in the tree. */
export interface Person {
  id: string;
  /** Linked account, or `null` for people without one (children, ancestors…). */
  userId: string | null;
  fullName: string;
  nickname: string | null;
  familyBranch: string | null;
  birthYear: number | null;
  deathYear: number | null;
  deceased: boolean;
  /** Presigned avatar URL (from the linked profile) or `null`. */
  avatarUrl: string | null;
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
  avatarUrl: z.string().max(4096).nullable()
}) satisfies z.ZodType<Person>;

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

const personFields = {
  fullName: displayTextSchema(200),
  nickname: nullableDisplayTextSchema(80),
  familyBranch: nullableTextSchema(120),
  birthYear: yearValue.nullable(),
  deathYear: yearValue.nullable(),
  deceased: z.boolean(),
  userId: idSchema.nullable()
};

function yearsConsistent(value: { birthYear?: number | null | undefined; deathYear?: number | null | undefined }): boolean {
  if (value.birthYear === null || value.birthYear === undefined) return true;
  if (value.deathYear === null || value.deathYear === undefined) return true;
  return value.deathYear >= value.birthYear;
}

const yearsIssue = { error: "El año de fallecimiento no puede ser anterior al de nacimiento.", path: ["deathYear"] };

/** `POST /api/admin/people`. */
export const createPersonInputSchema = z
  .object({
    ...personFields,
    nickname: nullableDisplayTextSchema(80).default(null),
    familyBranch: nullableTextSchema(120).default(null),
    birthYear: yearValue.nullable().default(null),
    deathYear: yearValue.nullable().default(null),
    deceased: z.boolean().default(false),
    userId: idSchema.nullable().default(null)
  })
  .refine(yearsConsistent, yearsIssue);
export type CreatePersonInput = z.infer<typeof createPersonInputSchema>;
export type CreatePersonRequest = z.input<typeof createPersonInputSchema>;

/** `PATCH /api/admin/people/:id`. `userId` links/unlinks an account (unique). */
export const updatePersonInputSchema = z
  .object(personFields)
  .partial()
  .refine(yearsConsistent, yearsIssue)
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type UpdatePersonInput = z.infer<typeof updatePersonInputSchema>;
export type UpdatePersonRequest = z.input<typeof updatePersonInputSchema>;

/**
 * `POST /api/admin/relationships`. The server rejects self-references,
 * duplicates and `parent_of` cycles (409 `CONFLICT`).
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

/**
 * `PATCH /api/family/me` (alias `PATCH /api/family/people/me`): a member edits limited fields of their *own* linked
 * person. Relationships remain admin-only.
 */
export const selfEditPersonInputSchema = z
  .object({
    nickname: nullableDisplayTextSchema(80),
    familyBranch: nullableTextSchema(120),
    birthYear: yearValue.nullable()
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type SelfEditPersonInput = z.infer<typeof selfEditPersonInputSchema>;
export type SelfEditPersonRequest = z.input<typeof selfEditPersonInputSchema>;
