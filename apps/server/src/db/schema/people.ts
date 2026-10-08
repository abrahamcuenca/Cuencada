/**
 * Family tree: people (with or without an account) and directed relationships.
 * Tree data is PII and member-only.
 */
import {
  AVATAR_MAX_BYTES,
  PERSON_BIO_MAX_LENGTH,
  PERSON_BIRTHPLACE_MAX_LENGTH,
  PersonRevisionAction,
  type PersonRevisionSnapshot,
  RelationshipKind,
  avatarMimeTypeSchema
} from "@cuencada/types";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { checkIn, createdAt, inList, timestamptz, updatedAt } from "./helpers.js";
import type { AvatarMimeType } from "./profiles.js";

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
    /**
     * Full dates (WP-4.0, migration 0004). The year columns stay the source
     * for "year only" people; when a date is set its year must equal
     * `birth_year`/`death_year` (the contract derives the year from the date).
     */
    birthDate: date("birth_date", { mode: "string" }),
    deathDate: date("death_date", { mode: "string" }),
    birthplace: text("birthplace"),
    bio: text("bio"),
    /** Object-storage key of the processed tree photo (shown when the person has no own avatar). */
    photoKey: text("photo_key"),
    photoUpdatedAt: timestamptz("photo_updated_at"),
    /** Last editor (WP-4.1 writes it on every change). */
    updatedByUserId: uuid("updated_by_user_id").references((): AnyPgColumn => users.id, {
      onDelete: "set null"
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("people_user_id_unique").on(table.userId),
    index("people_created_by_user_id_idx").on(table.createdByUserId),
    index("people_updated_by_user_id_idx").on(table.updatedByUserId),
    // Serves equality lookups on lower(full_name) only; `ILIKE '%q%'` search does not use it
    // (fine at family scale; add a pg_trgm GIN index in a later migration if needed).
    index("people_full_name_lower_idx").on(sql`lower(${table.fullName})`),
    check("people_birth_year_check", sql`"birth_year" is null or "birth_year" between 1800 and 2200`),
    check("people_death_year_check", sql`"death_year" is null or "death_year" between 1800 and 2200`),
    check(
      "people_years_order_check",
      sql`"birth_year" is null or "death_year" is null or "death_year" >= "birth_year"`
    ),
    check("people_death_implies_deceased_check", sql`"death_year" is null or "deceased"`),
    // WP-4.0: a date needs its year and must fall in it (so the year range and
    // death ⇒ deceased checks above also cover the dates).
    check(
      "people_birth_date_year_check",
      sql`"birth_date" is null or ("birth_year" is not null and extract(year from "birth_date") = "birth_year")`
    ),
    check(
      "people_death_date_year_check",
      sql`"death_date" is null or ("death_year" is not null and extract(year from "death_date") = "death_year")`
    ),
    check("people_dates_order_check", sql`"birth_date" is null or "death_date" is null or "death_date" >= "birth_date"`),
    check(
      "people_birthplace_length_check",
      sql.raw(`"birthplace" is null or char_length("birthplace") <= ${PERSON_BIRTHPLACE_MAX_LENGTH}`)
    ),
    check("people_bio_length_check", sql.raw(`"bio" is null or char_length("bio") <= ${PERSON_BIO_MAX_LENGTH}`)),
    check("people_photo_check", sql`"photo_key" is null or "photo_updated_at" is not null`)
  ]
);

/**
 * A presigned tree-photo upload awaiting confirmation (WP-4.3), mirroring
 * `avatar_uploads`. `id` is the contract's `uploadId`. Expired pending rows
 * are reclaimed like avatar uploads (cleanup job, WP-4.3).
 */
export const personPhotoUploads = pgTable(
  "person_photo_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    objectKey: text("object_key").notNull(),
    mimeType: text("mime_type").$type<AvatarMimeType>().notNull(),
    byteSize: integer("byte_size").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    confirmedAt: timestamptz("confirmed_at"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("person_photo_uploads_object_key_unique").on(table.objectKey),
    index("person_photo_uploads_person_id_idx").on(table.personId),
    index("person_photo_uploads_uploaded_by_user_id_idx").on(table.uploadedByUserId),
    check("person_photo_uploads_mime_type_check", inList("mime_type", avatarMimeTypeSchema.options)),
    check("person_photo_uploads_byte_size_check", sql.raw(`"byte_size" > 0 and "byte_size" <= ${AVATAR_MAX_BYTES}`))
  ]
);

/**
 * Undo history of family edits (WP-4.1 writes it; admins read and revert).
 *
 * [SEC] Holds PII (`before`/`after` snapshots: names, full dates, birthplace,
 * bio): **admin-only reads**, never copied to `audit_logs` (which keeps ids
 * and field names only). Retention one year, enforced by a cleanup job
 * (WP-4.1). See the table COMMENT in migration 0004.
 */
export const personRevisions = pgTable(
  "person_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** `set null` so history survives a person delete (the snapshot keeps the id). */
    personId: uuid("person_id").references((): AnyPgColumn => people.id, { onDelete: "set null" }),
    /** No FK: a deleted relationship's revisions must survive. */
    relationshipId: uuid("relationship_id"),
    actorUserId: uuid("actor_user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    action: text("action").$type<PersonRevisionAction>().notNull(),
    before: jsonb("before").$type<PersonRevisionSnapshot>(),
    after: jsonb("after").$type<PersonRevisionSnapshot>(),
    revertedByRevisionId: uuid("reverted_by_revision_id").references((): AnyPgColumn => personRevisions.id, {
      onDelete: "set null"
    }),
    createdAt: createdAt()
  },
  (table) => [
    index("person_revisions_person_id_created_at_idx").on(table.personId, table.createdAt.desc()),
    index("person_revisions_created_at_idx").on(table.createdAt),
    index("person_revisions_actor_user_id_idx").on(table.actorUserId),
    index("person_revisions_reverted_by_revision_id_idx")
      .on(table.revertedByRevisionId)
      .where(sql`"reverted_by_revision_id" is not null`),
    checkIn("person_revisions_action_check", "action", PersonRevisionAction),
    // Snapshots are objects that always name the person (Security L2: purge by person).
    check(
      "person_revisions_snapshots_check",
      sql`("before" is null or (jsonb_typeof("before") = 'object' and coalesce(jsonb_typeof("before" -> 'personId'), '') = 'string')) and ("after" is null or (jsonb_typeof("after") = 'object' and coalesce(jsonb_typeof("after" -> 'personId'), '') = 'string'))`
    ),
    check("person_revisions_has_snapshot_check", sql`"before" is not null or "after" is not null`),
    check(
      "person_revisions_not_self_reverted_check",
      sql`"reverted_by_revision_id" is null or "reverted_by_revision_id" <> "id"`
    )
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
    /**
     * WP-4.0 (Security M1): `true` when a **member** created the edge (only
     * possible together with a new person, `relateTo`). Such an edge counts for
     * the own-family circle only while `created_by_user_id` is also the
     * creator of one of its endpoints; admin edges (`false`, every row before
     * 0004) always count. See ADR 0001 §6.
     */
    createdByMember: boolean("created_by_member").notNull().default(false),
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
