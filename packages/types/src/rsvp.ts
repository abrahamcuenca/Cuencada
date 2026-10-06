/**
 * RSVPs (future editions, require an account) and historical attendance
 * (admin-entered, may reference people without accounts).
 */
import { z } from "zod";
import { dateSchema, dateTimeSchema, idSchema, nullableTextSchema } from "./common.js";

export const RsvpStatus = {
  Yes: "yes",
  Maybe: "maybe",
  No: "no"
} as const;
export type RsvpStatus = (typeof RsvpStatus)[keyof typeof RsvpStatus];
export const rsvpStatusSchema = z.enum(RsvpStatus);

/** Where an attendee row comes from. */
export const AttendeeSource = {
  Rsvp: "rsvp",
  Attendance: "attendance"
} as const;
export type AttendeeSource = (typeof AttendeeSource)[keyof typeof AttendeeSource];
export const attendeeSourceSchema = z.enum(AttendeeSource);

export const RSVP_MAX_GUESTS = 20;
export const RSVP_NOTES_MAX_LENGTH = 500;
/**
 * Arrival/departure must fall within this many days before the edition's
 * first day and after its last day (calendar days in the edition's timezone).
 * Checked server-side; clients may mirror it for date pickers.
 */
export const RSVP_DATE_WINDOW_DAYS = 14;
/** Max person ids in one attendance write. */
export const ATTENDANCE_MAX_PEOPLE = 1000;

/* -------------------------------------------------------------------------- */
/* My RSVP                                                                     */
/* -------------------------------------------------------------------------- */

/** The caller's own RSVP. */
export interface MyRsvp {
  cuencadaId: string;
  status: RsvpStatus;
  /** Extra people beyond the user (0–20). */
  guestCount: number;
  arrivalDate: string | null;
  departureDate: string | null;
  hotelLocationId: string | null;
  notes: string | null;
  updatedAt: string;
}

export const myRsvpSchema = z.object({
  cuencadaId: idSchema,
  status: rsvpStatusSchema,
  guestCount: z.number().int().min(0).max(RSVP_MAX_GUESTS),
  arrivalDate: dateSchema.nullable(),
  departureDate: dateSchema.nullable(),
  hotelLocationId: idSchema.nullable(),
  notes: z.string().max(RSVP_NOTES_MAX_LENGTH).nullable(),
  updatedAt: dateTimeSchema
}) satisfies z.ZodType<MyRsvp>;

/** `GET /api/cuencadas/:year/rsvp/me`. */
export interface MyRsvpResponse {
  rsvp: MyRsvp | null;
  /** RSVP deadline (ISO) or `null` if none. */
  deadline: string | null;
  /**
   * False once the edition is `past` or after the deadline. The deadline
   * counts to the end of its calendar day in the edition's timezone.
   */
  editable: boolean;
}

export const myRsvpResponseSchema = z.object({
  rsvp: myRsvpSchema.nullable(),
  deadline: dateTimeSchema.nullable(),
  editable: z.boolean()
}) satisfies z.ZodType<MyRsvpResponse>;

/**
 * `PUT /api/cuencadas/:year/rsvp/me` (idempotent upsert). `hotelLocationId`
 * must be a `hotel` location of the same Cuencada and the dates must fall in
 * the `RSVP_DATE_WINDOW_DAYS` window around the edition (both checked
 * server-side, 400 `VALIDATION`). When the edition is not editable
 * (`MyRsvpResponse.editable === false`) the server answers 409 `CONFLICT`.
 */
export const upsertRsvpInputSchema = z
  .object({
    status: rsvpStatusSchema,
    guestCount: z
      .number()
      .int()
      .min(0, { error: "El número de acompañantes no puede ser negativo." })
      .max(RSVP_MAX_GUESTS, { error: `Máximo ${RSVP_MAX_GUESTS} acompañantes.` })
      .default(0),
    arrivalDate: dateSchema.nullable().default(null),
    departureDate: dateSchema.nullable().default(null),
    hotelLocationId: idSchema.nullable().default(null),
    notes: nullableTextSchema(RSVP_NOTES_MAX_LENGTH).default(null)
  })
  .refine(
    (value) => value.arrivalDate === null || value.departureDate === null || value.departureDate >= value.arrivalDate,
    { error: "La salida debe ser igual o posterior a la llegada.", path: ["departureDate"] }
  );
export type UpsertRsvpInput = z.infer<typeof upsertRsvpInputSchema>;
export type UpsertRsvpRequest = z.input<typeof upsertRsvpInputSchema>;

/* -------------------------------------------------------------------------- */
/* Summary and attendees                                                       */
/* -------------------------------------------------------------------------- */

export interface RsvpHotelCount {
  locationId: string;
  name: string;
  /** People (RSVP holders + guests) staying there, `yes` only. */
  people: number;
}

/** `GET /api/cuencadas/:year/rsvp/summary` (members). Aggregated in SQL. */
export interface RsvpSummary {
  cuencadaId: string;
  yes: number;
  maybe: number;
  no: number;
  /** `yes` RSVPs plus their guests. */
  expectedPeople: number;
  byHotel: RsvpHotelCount[];
}

export const rsvpSummarySchema = z.object({
  cuencadaId: idSchema,
  yes: z.number().int(),
  maybe: z.number().int(),
  no: z.number().int(),
  expectedPeople: z.number().int(),
  byHotel: z.array(
    z.object({
      locationId: idSchema,
      name: z.string().max(200),
      people: z.number().int()
    }) satisfies z.ZodType<RsvpHotelCount>
  )
}) satisfies z.ZodType<RsvpSummary>;

/**
 * One circle in the attendee strip (`GET /api/cuencadas/:year/attendees`).
 * Verified members only. Union of `yes` RSVPs (active accounts) and
 * historical attendance, deduplicated by person (by user when the account has
 * no linked person), sorted by `displayName`. Never carries contact fields.
 * Accounts with `listedInDirectory = false` appear to others as
 * `displayName: "Familiar"` with `avatarUrl`, `personId` and `userId` all
 * `null` (they still count); the caller's own row is always complete.
 */
export interface Attendee {
  personId: string | null;
  userId: string | null;
  displayName: string;
  /** Short-lived presigned URL of the account's avatar, or `null`. */
  avatarUrl: string | null;
  /** `rsvp` when a `yes` RSVP exists (even if attendance is also recorded). */
  source: AttendeeSource;
  /** `null` for attendance-only rows. */
  rsvpStatus: RsvpStatus | null;
  /** True for the caller's own row. */
  isMe: boolean;
}

export const attendeeSchema = z.object({
  personId: idSchema.nullable(),
  userId: idSchema.nullable(),
  displayName: z.string().max(200),
  avatarUrl: z.string().max(4096).nullable(),
  source: attendeeSourceSchema,
  rsvpStatus: rsvpStatusSchema.nullable(),
  isMe: z.boolean()
}) satisfies z.ZodType<Attendee>;

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

/** One row of the admin RSVP table / CSV export. Contains PII: admin only. */
export interface AdminRsvpRow {
  userId: string;
  personId: string | null;
  displayName: string;
  email: string;
  status: RsvpStatus;
  guestCount: number;
  arrivalDate: string | null;
  departureDate: string | null;
  hotelName: string | null;
  notes: string | null;
  updatedAt: string;
}

export const adminRsvpRowSchema = z.object({
  userId: idSchema,
  personId: idSchema.nullable(),
  displayName: z.string().max(80),
  email: z.string().max(254),
  status: rsvpStatusSchema,
  guestCount: z.number().int(),
  arrivalDate: dateSchema.nullable(),
  departureDate: dateSchema.nullable(),
  hotelName: z.string().max(200).nullable(),
  notes: z.string().max(RSVP_NOTES_MAX_LENGTH).nullable(),
  updatedAt: dateTimeSchema
}) satisfies z.ZodType<AdminRsvpRow>;

/** Historical attendance record. */
export interface AttendanceRecord {
  personId: string;
  displayName: string;
  createdAt: string;
}

export const attendanceRecordSchema = z.object({
  personId: idSchema,
  displayName: z.string().max(200),
  createdAt: dateTimeSchema
}) satisfies z.ZodType<AttendanceRecord>;

/**
 * `POST /api/admin/cuencadas/:id/attendance` body. Adds and removes people
 * in one transaction; responds with the full `AttendanceRecord[]`.
 */
export const adminAttendanceBulkInputSchema = z
  .object({
    add: z.array(idSchema).max(ATTENDANCE_MAX_PEOPLE).default([]),
    remove: z.array(idSchema).max(ATTENDANCE_MAX_PEOPLE).default([])
  })
  .refine((value) => value.add.length + value.remove.length > 0, { error: "No hay cambios que guardar." })
  .refine((value) => !value.add.some((id) => value.remove.includes(id)), {
    error: "Una persona no puede agregarse y quitarse a la vez.",
    path: ["remove"]
  });
export type AdminAttendanceBulkInput = z.infer<typeof adminAttendanceBulkInputSchema>;
export type AdminAttendanceBulkRequest = z.input<typeof adminAttendanceBulkInputSchema>;

/**
 * `PUT /api/admin/cuencadas/:id/attendance` body: the complete set of people
 * who attended. People missing from the list are removed and new ones added,
 * in one transaction; responds with the full `AttendanceRecord[]`. An empty
 * list clears the edition's attendance. Duplicate ids are rejected.
 */
export const adminAttendanceReplaceInputSchema = z.object({
  personIds: z
    .array(idSchema)
    .max(ATTENDANCE_MAX_PEOPLE, { error: `Máximo ${ATTENDANCE_MAX_PEOPLE} personas.` })
    .refine((ids) => new Set(ids).size === ids.length, { error: "Hay personas repetidas en la lista." })
});
export type AdminAttendanceReplaceInput = z.infer<typeof adminAttendanceReplaceInputSchema>;
export type AdminAttendanceReplaceRequest = z.input<typeof adminAttendanceReplaceInputSchema>;
