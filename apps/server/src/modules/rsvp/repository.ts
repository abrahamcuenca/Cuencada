/**
 * RSVP and attendance queries. Every list is a fixed number of queries per
 * request (no per-row lookups); counts are aggregated in SQL.
 *
 * Reads `users`, `people`, `profiles` and `cuencada_locations` read-only.
 */
import { LocationKind, type RsvpStatus, UserStatus } from "@cuencada/types";
import { and, asc, eq, getTableColumns, inArray, notInArray, sql } from "drizzle-orm";
import {
  cuencadaAttendance,
  cuencadaLocations,
  cuencadaRsvps,
  people,
  profiles,
  users
} from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";

/** A stored RSVP row. */
export type RsvpRow = typeof cuencadaRsvps.$inferSelect;

/**
 * The caller's RSVP for an edition, if any.
 *
 * @param db - Client or transaction.
 * @param cuencadaId - Edition.
 * @param userId - Caller.
 */
export async function findRsvp(db: DbOrTx, cuencadaId: string, userId: string): Promise<RsvpRow | undefined> {
  const [row] = await db
    .select()
    .from(cuencadaRsvps)
    .where(and(eq(cuencadaRsvps.cuencadaId, cuencadaId), eq(cuencadaRsvps.userId, userId)))
    .limit(1);
  return row;
}

/** Fields written by {@link upsertRsvp}. */
export interface RsvpWrite {
  cuencadaId: string;
  userId: string;
  status: RsvpStatus;
  guestCount: number;
  arrivalDate: string | null;
  departureDate: string | null;
  hotelLocationId: string | null;
  notes: string | null;
}

/**
 * Insert or update the caller's RSVP on the unique `(cuencada_id, user_id)`.
 *
 * @param db - Transaction.
 * @param values - New values.
 * @param now - Timestamp for `created_at`/`updated_at` (`app.clock`).
 * @returns The stored row and whether it was newly created.
 */
export async function upsertRsvp(
  db: DbOrTx,
  values: RsvpWrite,
  now: Date
): Promise<{ row: RsvpRow; created: boolean }> {
  const { cuencadaId, userId, ...changes } = values;
  const [result] = await db
    .insert(cuencadaRsvps)
    .values({ ...values, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [cuencadaRsvps.cuencadaId, cuencadaRsvps.userId],
      set: { ...changes, updatedAt: now }
    })
    // `xmax = 0` only for a freshly inserted tuple (the update path sets it).
    .returning({
      ...getTableColumns(cuencadaRsvps),
      created: sql<boolean>`(xmax = 0)`
    });
  if (result === undefined) throw new Error("upsertRsvp: no row returned");
  const { created, ...row } = result;
  return { row, created: Boolean(created) };
}

/** Location fields needed to validate a hotel choice. */
export interface LocationRef {
  id: string;
  cuencadaId: string;
  kind: LocationKind;
}

/**
 * A location by id (any edition), or `undefined`.
 *
 * @param db - Client or transaction.
 * @param id - Location id.
 */
export async function findLocation(db: DbOrTx, id: string): Promise<LocationRef | undefined> {
  const [row] = await db
    .select({
      id: cuencadaLocations.id,
      cuencadaId: cuencadaLocations.cuencadaId,
      kind: cuencadaLocations.kind
    })
    .from(cuencadaLocations)
    .where(eq(cuencadaLocations.id, id))
    .limit(1);
  return row;
}

/** Aggregated counts for {@link rsvpSummaryCounts}. */
export interface RsvpCounts {
  yes: number;
  maybe: number;
  no: number;
  expectedPeople: number;
}

/** Only RSVPs of active accounts count (disabled accounts are hidden everywhere). */
const activeRsvpUser = and(eq(users.id, cuencadaRsvps.userId), eq(users.status, UserStatus.Active));

/**
 * Counts by status and expected people (`yes` holders + their guests), in one query.
 *
 * @param db - Client.
 * @param cuencadaId - Edition.
 */
export async function rsvpSummaryCounts(db: DbOrTx, cuencadaId: string): Promise<RsvpCounts> {
  const [row] = await db
    .select({
      yes: sql<number>`count(*) filter (where ${cuencadaRsvps.status} = 'yes')::int`,
      maybe: sql<number>`count(*) filter (where ${cuencadaRsvps.status} = 'maybe')::int`,
      no: sql<number>`count(*) filter (where ${cuencadaRsvps.status} = 'no')::int`,
      expectedPeople: sql<number>`coalesce(sum(1 + ${cuencadaRsvps.guestCount}) filter (where ${cuencadaRsvps.status} = 'yes'), 0)::int`
    })
    .from(cuencadaRsvps)
    .innerJoin(users, activeRsvpUser)
    .where(eq(cuencadaRsvps.cuencadaId, cuencadaId));
  return {
    yes: Number(row?.yes ?? 0),
    maybe: Number(row?.maybe ?? 0),
    no: Number(row?.no ?? 0),
    expectedPeople: Number(row?.expectedPeople ?? 0)
  };
}

/** People staying at each hotel (`yes` RSVPs, holders + guests), in the edition's location order. */
export async function rsvpHotelCounts(
  db: DbOrTx,
  cuencadaId: string
): Promise<Array<{ locationId: string; name: string; people: number }>> {
  const rows = await db
    .select({
      locationId: cuencadaLocations.id,
      name: cuencadaLocations.name,
      people: sql<number>`sum(1 + ${cuencadaRsvps.guestCount})::int`
    })
    .from(cuencadaRsvps)
    .innerJoin(users, activeRsvpUser)
    .innerJoin(
      cuencadaLocations,
      and(
        eq(cuencadaLocations.id, cuencadaRsvps.hotelLocationId),
        eq(cuencadaLocations.cuencadaId, cuencadaRsvps.cuencadaId)
      )
    )
    .where(and(eq(cuencadaRsvps.cuencadaId, cuencadaId), eq(cuencadaRsvps.status, "yes")))
    .groupBy(cuencadaLocations.id, cuencadaLocations.name, cuencadaLocations.sortOrder)
    .orderBy(asc(cuencadaLocations.sortOrder), asc(cuencadaLocations.name));
  return rows.map((row) => ({ ...row, people: Number(row.people) }));
}

/** One raw attendee candidate before deduplication. */
export interface AttendeeCandidate {
  personId: string | null;
  userId: string | null;
  /** Account display name when the person has an account. */
  accountName: string | null;
  /** `people.nickname` / `people.full_name` for people without accounts. */
  nickname: string | null;
  fullName: string | null;
  avatarKey: string | null;
  /** `profiles.listed_in_directory` of the linked account; `null` without an account/profile. */
  listedInDirectory: boolean | null;
}

/**
 * Historical attendance rows with the person's linked account (if any).
 *
 * @param db - Client.
 * @param cuencadaId - Edition.
 */
export async function attendanceCandidates(db: DbOrTx, cuencadaId: string): Promise<AttendeeCandidate[]> {
  return db
    .select({
      personId: people.id,
      userId: users.id,
      accountName: users.displayName,
      nickname: people.nickname,
      fullName: people.fullName,
      avatarKey: profiles.avatarKey,
      listedInDirectory: profiles.listedInDirectory
    })
    .from(cuencadaAttendance)
    .innerJoin(people, eq(people.id, cuencadaAttendance.personId))
    .leftJoin(users, eq(users.id, people.userId))
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(cuencadaAttendance.cuencadaId, cuencadaId));
}

/**
 * `yes` RSVPs of active accounts with their linked person (if any).
 *
 * @param db - Client.
 * @param cuencadaId - Edition.
 */
export async function yesRsvpCandidates(db: DbOrTx, cuencadaId: string): Promise<AttendeeCandidate[]> {
  return db
    .select({
      personId: people.id,
      userId: users.id,
      accountName: users.displayName,
      nickname: people.nickname,
      fullName: people.fullName,
      avatarKey: profiles.avatarKey,
      listedInDirectory: profiles.listedInDirectory
    })
    .from(cuencadaRsvps)
    .innerJoin(users, activeRsvpUser)
    .leftJoin(people, eq(people.userId, cuencadaRsvps.userId))
    .leftJoin(profiles, eq(profiles.userId, cuencadaRsvps.userId))
    .where(and(eq(cuencadaRsvps.cuencadaId, cuencadaId), eq(cuencadaRsvps.status, "yes")));
}

/** A row of the admin RSVP table before mapping. */
export interface AdminRsvpRecord {
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
  updatedAt: Date;
}

/**
 * Every RSVP of an edition (any account status) with name, email and hotel.
 *
 * @param db - Client or transaction.
 * @param cuencadaId - Edition.
 */
export async function listAdminRsvps(db: DbOrTx, cuencadaId: string): Promise<AdminRsvpRecord[]> {
  return db
    .select({
      userId: cuencadaRsvps.userId,
      personId: people.id,
      displayName: users.displayName,
      email: users.email,
      status: cuencadaRsvps.status,
      guestCount: cuencadaRsvps.guestCount,
      arrivalDate: cuencadaRsvps.arrivalDate,
      departureDate: cuencadaRsvps.departureDate,
      hotelName: cuencadaLocations.name,
      notes: cuencadaRsvps.notes,
      updatedAt: cuencadaRsvps.updatedAt
    })
    .from(cuencadaRsvps)
    .innerJoin(users, eq(users.id, cuencadaRsvps.userId))
    .leftJoin(people, eq(people.userId, cuencadaRsvps.userId))
    .leftJoin(cuencadaLocations, eq(cuencadaLocations.id, cuencadaRsvps.hotelLocationId))
    .where(eq(cuencadaRsvps.cuencadaId, cuencadaId))
    .orderBy(asc(users.displayName), asc(users.id));
}

/** A historical attendance row with the person's name. */
export interface AttendanceListRow {
  personId: string;
  fullName: string;
  createdAt: Date;
}

/**
 * Attendance of an edition, by name.
 *
 * @param db - Client or transaction.
 * @param cuencadaId - Edition.
 */
export async function listAttendance(db: DbOrTx, cuencadaId: string): Promise<AttendanceListRow[]> {
  return db
    .select({
      personId: people.id,
      fullName: people.fullName,
      createdAt: cuencadaAttendance.createdAt
    })
    .from(cuencadaAttendance)
    .innerJoin(people, eq(people.id, cuencadaAttendance.personId))
    .where(eq(cuencadaAttendance.cuencadaId, cuencadaId))
    .orderBy(asc(people.fullName), asc(people.id));
}

/**
 * Which of `ids` exist in `people` (one query).
 *
 * @param db - Client or transaction.
 * @param ids - Candidate person ids.
 */
export async function existingPersonIds(db: DbOrTx, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(inArray(people.id, [...ids]));
  return new Set(rows.map((row) => row.id));
}

/**
 * Add people to an edition's attendance; existing pairs are left untouched.
 *
 * @param db - Transaction.
 * @param cuencadaId - Edition.
 * @param personIds - People to add (must exist).
 * @param actorUserId - Admin recorded as `created_by_user_id`.
 * @param now - `created_at` (`app.clock`).
 * @returns How many rows were actually inserted.
 */
export async function addAttendance(
  db: DbOrTx,
  cuencadaId: string,
  personIds: readonly string[],
  actorUserId: string,
  now: Date
): Promise<number> {
  if (personIds.length === 0) return 0;
  const inserted = await db
    .insert(cuencadaAttendance)
    .values(
      personIds.map((personId) => ({
        cuencadaId,
        personId,
        createdByUserId: actorUserId,
        createdAt: now
      }))
    )
    .onConflictDoNothing({
      target: [cuencadaAttendance.cuencadaId, cuencadaAttendance.personId]
    })
    .returning({ id: cuencadaAttendance.id });
  return inserted.length;
}

/**
 * Remove the listed people from an edition's attendance.
 *
 * @returns How many rows were deleted.
 */
export async function removeAttendance(db: DbOrTx, cuencadaId: string, personIds: readonly string[]): Promise<number> {
  if (personIds.length === 0) return 0;
  const deleted = await db
    .delete(cuencadaAttendance)
    .where(and(eq(cuencadaAttendance.cuencadaId, cuencadaId), inArray(cuencadaAttendance.personId, [...personIds])))
    .returning({ id: cuencadaAttendance.id });
  return deleted.length;
}

/**
 * Remove everyone **not** in `keep` from an edition's attendance.
 *
 * @returns How many rows were deleted.
 */
export async function removeAttendanceExcept(db: DbOrTx, cuencadaId: string, keep: readonly string[]): Promise<number> {
  const condition =
    keep.length === 0
      ? eq(cuencadaAttendance.cuencadaId, cuencadaId)
      : and(eq(cuencadaAttendance.cuencadaId, cuencadaId), notInArray(cuencadaAttendance.personId, [...keep]));
  const deleted = await db.delete(cuencadaAttendance).where(condition).returning({ id: cuencadaAttendance.id });
  return deleted.length;
}

/** `true` when the location is a hotel of the given edition. */
export function isHotelOf(location: LocationRef | undefined, cuencadaId: string): boolean {
  return location !== undefined && location.cuencadaId === cuencadaId && location.kind === LocationKind.Hotel;
}
