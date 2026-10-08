/**
 * Member profiles (directory PII, member-only, gated by the `show_*` flags)
 * and pending avatar uploads.
 */
import {
  AVATAR_MAX_BYTES,
  CONTACT_HANDLE_RULES,
  CONTACT_WEBSITE_MAX_LENGTH,
  E164_MAX_LENGTH,
  E164_PATTERN,
  type HandleNetwork,
  STORED_CONTACT_VISIBILITY_KEYS,
  type StoredContactVisibility,
  avatarMimeTypeSchema
} from "@cuencada/types";
import { type SQL, sql } from "drizzle-orm";
import {
  type CheckBuilder,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { createdAt, inList, timestamptz, updatedAt } from "./helpers.js";
import { users } from "./auth.js";

/** Avatar MIME types accepted by the contract (JPEG, PNG, WebP). */
export type AvatarMimeType = (typeof avatarMimeTypeSchema.options)[number];

/** SQL string literal for a trusted constant (regex sources from the contract). */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * `profiles_<network>_check`: the handle matches the contract's
 * `CONTACT_HANDLE_RULES[network]` (the same regex source, so API and DB agree).
 */
function handleCheck(network: HandleNetwork): CheckBuilder {
  const rule = CONTACT_HANDLE_RULES[network];
  const column = `"${network}"`;
  return check(
    `profiles_${network}_check`,
    sql.raw(`${column} is null or (char_length(${column}) <= ${rule.maxLength} and ${column} ~ ${literal(rule.pattern)})`)
  );
}

/** `contact_visibility` is a JSON object over the stored contact kinds only, with boolean values. */
function contactVisibilityCheck(): SQL {
  const keys = STORED_CONTACT_VISIBILITY_KEYS.map(literal).join(", ");
  const objectOfKnownKeys = `jsonb_typeof("contact_visibility") = 'object' and ("contact_visibility" - array[${keys}]::text[]) = '{}'::jsonb`;
  const booleanValues = `not jsonb_path_exists("contact_visibility", '$.* ? (@.type() != "boolean")')`;
  return sql.raw(`${objectOfKnownKeys} and ${booleanValues}`);
}

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    familyBranch: text("family_branch"),
    city: text("city"),
    phone: text("phone"),
    /** Object-storage key of the processed avatar; URLs are presigned on read. */
    avatarKey: text("avatar_key"),
    bio: text("bio"),
    showEmail: boolean("show_email").notNull().default(false),
    showPhone: boolean("show_phone").notNull().default(false),
    showCity: boolean("show_city").notNull().default(false),
    /** "Aparecer en el directorio": `false` hides the member from directory and attendee lists. */
    listedInDirectory: boolean("listed_in_directory").notNull().default(true),
    // Contacts (WP-4.0, migration 0004). Social networks are handles only;
    // links are built server-side by `buildContactCard`. `phone` (above) is
    // still free-form until a later WP backfills it to E.164.
    /** E.164 (`+525550100101`). */
    whatsapp: text("whatsapp"),
    instagram: text("instagram"),
    facebook: text("facebook"),
    tiktok: text("tiktok"),
    linkedin: text("linkedin"),
    github: text("github"),
    /** Canonical `https://` URL. */
    website: text("website"),
    /**
     * "Mostrar a la familia" for the seven new contact kinds (missing key =
     * hidden). `show_email`/`show_phone`/`show_city` stay the source of truth
     * for those fields.
     */
    contactVisibility: jsonb("contact_visibility").$type<StoredContactVisibility>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("profiles_user_id_unique").on(table.userId),
    check(
      "profiles_whatsapp_check",
      sql.raw(`"whatsapp" is null or (char_length("whatsapp") <= ${E164_MAX_LENGTH} and "whatsapp" ~ ${literal(E164_PATTERN)})`)
    ),
    handleCheck("instagram"),
    handleCheck("facebook"),
    handleCheck("tiktok"),
    handleCheck("linkedin"),
    handleCheck("github"),
    check(
      "profiles_website_check",
      sql.raw(`"website" is null or (char_length("website") <= ${CONTACT_WEBSITE_MAX_LENGTH} and "website" ~ '^https://')`)
    ),
    check("profiles_contact_visibility_check", contactVisibilityCheck())
  ]
);

/** A presigned avatar upload awaiting confirmation. `id` is the contract's `uploadId`. */
export const avatarUploads = pgTable(
  "avatar_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    mimeType: text("mime_type").$type<AvatarMimeType>().notNull(),
    byteSize: integer("byte_size").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    confirmedAt: timestamptz("confirmed_at"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("avatar_uploads_object_key_unique").on(table.objectKey),
    index("avatar_uploads_user_id_idx").on(table.userId),
    check("avatar_uploads_mime_type_check", inList("mime_type", avatarMimeTypeSchema.options)),
    check("avatar_uploads_byte_size_check", sql.raw(`"byte_size" > 0 and "byte_size" <= ${AVATAR_MAX_BYTES}`))
  ]
);
