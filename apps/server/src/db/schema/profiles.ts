/**
 * Member profiles (directory PII, member-only, gated by the `show_*` flags)
 * and pending avatar uploads.
 */
import { AVATAR_MAX_BYTES, avatarMimeTypeSchema } from "@cuencada/types";
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, inList, timestamptz, updatedAt } from "./helpers.js";
import { users } from "./auth.js";

/** Avatar MIME types accepted by the contract (JPEG, PNG, WebP). */
export type AvatarMimeType = (typeof avatarMimeTypeSchema.options)[number];

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
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [uniqueIndex("profiles_user_id_unique").on(table.userId)]
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
