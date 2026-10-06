/**
 * Family tree: people (with or without an account) and directed relationships.
 * Tree data is PII and member-only.
 */
import { RelationshipKind } from "@cuencada/types";
import { sql } from "drizzle-orm";
import { type AnyPgColumn, boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { checkIn, createdAt, updatedAt } from "./helpers.js";

export const people = pgTable(
  "people",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Linked account (at most one person per user), or `null`. */
    userId: uuid("user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    fullName: text("full_name").notNull(),
    nickname: text("nickname"),
    familyBranch: text("family_branch"),
    birthYear: integer("birth_year"),
    deathYear: integer("death_year"),
    deceased: boolean("deceased").notNull().default(false),
    createdByUserId: uuid("created_by_user_id").references((): AnyPgColumn => users.id, {
      onDelete: "set null"
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("people_user_id_unique").on(table.userId),
    index("people_created_by_user_id_idx").on(table.createdByUserId),
    // Serves equality lookups on lower(full_name) only; `ILIKE '%q%'` search does not use it
    // (fine at family scale; add a pg_trgm GIN index in a later migration if needed).
    index("people_full_name_lower_idx").on(sql`lower(${table.fullName})`),
    check("people_birth_year_check", sql`"birth_year" is null or "birth_year" between 1800 and 2200`),
    check("people_death_year_check", sql`"death_year" is null or "death_year" between 1800 and 2200`),
    check(
      "people_years_order_check",
      sql`"birth_year" is null or "death_year" is null or "death_year" >= "birth_year"`
    ),
    check("people_death_implies_deceased_check", sql`"death_year" is null or "deceased"`)
  ]
);

/**
 * Directed edge `from → to`: `parent_of` (from is a parent of to) or
 * `partner_of` (stored once per pair; the partial unique index rejects the
 * mirrored row). Cycle checks for `parent_of` live in the service (T6).
 */
export const personRelationships = pgTable(
  "person_relationships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").$type<RelationshipKind>().notNull(),
    fromPersonId: uuid("from_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    toPersonId: uuid("to_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("person_relationships_kind_from_to_unique").on(table.kind, table.fromPersonId, table.toPersonId),
    uniqueIndex("person_relationships_partner_pair_unique")
      .on(sql`least(${table.fromPersonId}, ${table.toPersonId})`, sql`greatest(${table.fromPersonId}, ${table.toPersonId})`)
      .where(sql`kind = 'partner_of'`),
    index("person_relationships_from_person_id_idx").on(table.fromPersonId),
    index("person_relationships_to_person_id_idx").on(table.toPersonId),
    index("person_relationships_created_by_user_id_idx").on(table.createdByUserId),
    checkIn("person_relationships_kind_check", "kind", RelationshipKind),
    check("person_relationships_no_self_check", sql`"from_person_id" <> "to_person_id"`)
  ]
);
