import { relations, sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const profiles = pgTable("profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  familyBranch: text("family_branch"),
  city: text("city"),
  phone: text("phone"),
  photoUrl: text("photo_url"),
  bio: text("bio"),
  showEmail: boolean("show_email").notNull().default(false),
  showPhone: boolean("show_phone").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  tokenHash: text("token_hash").notNull(),
  email: text("email"),
  role: text("role").notNull().default("member"),
  maxUses: integer("max_uses").notNull().default(1),
  useCount: integer("use_count").notNull().default(0),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const magicLinks = pgTable("magic_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  purpose: text("purpose").notNull().default("login"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const cuencadas = pgTable("cuencadas", {
  id: uuid("id").defaultRandom().primaryKey(),
  year: integer("year").notNull().unique(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  status: text("status").notNull().default("upcoming"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  country: text("country").notNull().default("México"),
  description: text("description").notNull(),
  heroImageUrl: text("hero_image_url"),
  themeColor: text("theme_color").notNull().default("#0b5e55"),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const cuencadaLocations = pgTable("cuencada_locations", {
  id: uuid("id").defaultRandom().primaryKey(),
  cuencadaId: uuid("cuencada_id").notNull().references(() => cuencadas.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("other"),
  address: text("address"),
  url: text("url"),
  displayOrder: integer("display_order").notNull().default(0)
});

export const cuencadaItineraryItems = pgTable("cuencada_itinerary_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  cuencadaId: uuid("cuencada_id").notNull().references(() => cuencadas.id, { onDelete: "cascade" }),
  itemDate: timestamp("item_date", { withTimezone: true }).notNull(),
  itemTime: text("item_time"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  locationName: text("location_name"),
  visibility: text("visibility").notNull().default("public"),
  displayOrder: integer("display_order").notNull().default(0)
});

export const cuencadaRsvps = pgTable(
  "cuencada_rsvps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cuencadaId: uuid("cuencada_id").notNull().references(() => cuencadas.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    guestCount: integer("guest_count").notNull().default(0),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({ uniqueRsvp: uniqueIndex("cuencada_rsvps_cuencada_user_idx").on(table.cuencadaId, table.userId) })
);

export const mediaItems = pgTable("media_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  cuencadaId: uuid("cuencada_id").notNull().references(() => cuencadas.id, { onDelete: "cascade" }),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id),
  objectKey: text("object_key").notNull(),
  bucket: text("bucket").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  caption: text("caption"),
  visibility: text("visibility").notNull().default("members"),
  moderationStatus: text("moderation_status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const familyRelationships = pgTable("family_relationships", {
  id: uuid("id").defaultRandom().primaryKey(),
  personUserId: uuid("person_user_id").references(() => users.id, { onDelete: "cascade" }),
  relativeUserId: uuid("relative_user_id").references(() => users.id, { onDelete: "cascade" }),
  relationshipType: text("relationship_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const chatRooms = pgTable("chat_rooms", {
  id: uuid("id").defaultRandom().primaryKey(),
  cuencadaId: uuid("cuencada_id").references(() => cuencadas.id, { onDelete: "cascade" }),
  roomType: text("room_type").notNull(),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const chatParticipants = pgTable(
  "chat_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id").notNull().references(() => chatRooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({ uniqueParticipant: uniqueIndex("chat_participants_room_user_idx").on(table.roomId, table.userId) })
);

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  roomId: uuid("room_id").notNull().references(() => chatRooms.id, { onDelete: "cascade" }),
  senderUserId: uuid("sender_user_id").references(() => users.id),
  body: text("body").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const announcements = pgTable("announcements", {
  id: uuid("id").defaultRandom().primaryKey(),
  cuencadaId: uuid("cuencada_id").references(() => cuencadas.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  visibility: text("visibility").notNull().default("members"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  metadata: text("metadata").notNull().default(sql`'{}'::text`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(profiles),
  sessions: many(sessions),
  rsvps: many(cuencadaRsvps)
}));
