/**
 * RSVPs (account holders, upcoming editions) and historical attendance (by
 * person, so attendees without accounts can be recorded).
 */
import { RSVP_MAX_GUESTS, RSVP_NOTES_MAX_LENGTH, RsvpStatus } from "@cuencada/types";
import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { cuencadaLocations, cuencadas } from "./cuencadas.js";
import { checkIn, createdAt, updatedAt } from "./helpers.js";
import { people } from "./people.js";

export const cuencadaRsvps = pgTable(
  "cuencada_rsvps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cuencadaId: uuid("cuencada_id")
      .notNull()
      .references(() => cuencadas.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").$type<RsvpStatus>().notNull(),
    /** Extra people beyond the user. */
    guestCount: integer("guest_count").notNull().default(0),
    arrivalDate: date("arrival_date"),
    departureDate: date("departure_date"),
    /** Must be a location of the same Cuencada; enforced by the service. */
    hotelLocationId: uuid("hotel_location_id").references(() => cuencadaLocations.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("cuencada_rsvps_cuencada_user_idx").on(table.cuencadaId, table.userId),
    index("cuencada_rsvps_user_id_idx").on(table.userId),
    index("cuencada_rsvps_hotel_location_id_idx").on(table.hotelLocationId),
    checkIn("cuencada_rsvps_status_check", "status", RsvpStatus),
    check("cuencada_rsvps_guest_count_check", sql.raw(`"guest_count" between 0 and ${RSVP_MAX_GUESTS}`)),
    check(
      "cuencada_rsvps_dates_check",
      sql`"arrival_date" is null or "departure_date" is null or "departure_date" >= "arrival_date"`
    ),
    check(
      "cuencada_rsvps_notes_length_check",
      sql.raw(`"notes" is null or char_length("notes") <= ${RSVP_NOTES_MAX_LENGTH}`)
    )
  ]
);

/** Who attended an edition (admin-maintained, includes people without accounts). */
export const cuencadaAttendance = pgTable(
  "cuencada_attendance",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cuencadaId: uuid("cuencada_id")
      .notNull()
      .references(() => cuencadas.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("cuencada_attendance_cuencada_person_unique").on(table.cuencadaId, table.personId),
    index("cuencada_attendance_person_id_idx").on(table.personId),
    index("cuencada_attendance_created_by_user_id_idx").on(table.createdByUserId)
  ]
);
