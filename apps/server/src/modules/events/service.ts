/**
 * Event writes and the detail builder (WP-5.3, ADR 0001 §7) [SEC].
 *
 * Order of checks in every write: (1) lock the row and load it **through
 * the visibility predicate** (404 `EVENT_NOT_FOUND`, same path for unknown
 * and invisible ids), (2) the caller's permission (403 with a detail code),
 * (3) state rules (409, merged-row validation 400). Each write records one
 * or more audit rows with ids, enums, field names and counts only (never
 * titles or names) in the same transaction. Writes that change who may
 * read the chat room refresh the hub before returning (`chatSync.ts`).
 */
import {
  type AddEventParticipantsInput,
  type AdminCreateEventInput,
  type AdminUpdateEventInput,
  AuditAction,
  AuditEntityType,
  type CreateEventAlbumInput,
  type CreateEventInput,
  DEFAULT_EVENT_ALBUM_TITLE,
  EVENT_ALBUM_SORT_ORDER_MAX,
  EVENT_ALBUMS_MAX,
  EVENT_PARTICIPANTS_MAX,
  EVENT_SLUG_MAX_ATTEMPTS,
  type EventDetail,
  EventRole,
  EventStatus,
  type UpdateEventAlbumInput,
  eventDatesIssue,
  eventYearOf,
  memberEventSlug,
  randomEventSlugSuffix
} from "@cuencada/types";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  chatRooms,
  eventAlbums,
  eventCoverUploads,
  eventParticipants,
  events,
  mediaItems
} from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import type { AuthUser } from "../../plugins/auth.js";
import { PgErrorCode, pgErrorInfo } from "../family/db-errors.js";
import { allObjectKeys } from "../media/service.js";
import { deleteObjectsQuietly } from "../profile/uploadPipeline.js";
import { type EventViewer, isEventAdmin } from "./access.js";
import { AdminViewSurface, auditAdminEventView } from "./adminView.js";
import { removeEventRoom, snapshotEventRoom, syncEventRoom } from "./chatSync.js";
import { EVENT_CREATE_DAILY_MAX, EVENT_CREATE_WINDOW_MS, EVENT_OPEN_DRAFTS_MAX } from "./constants.js";
import { coverDerivativeKeys, coverKeys } from "./cover.js";
import {
  albumNotFound,
  eventAlbumNotEmpty,
  eventDeleteNotAllowed,
  eventJoinNotAllowed,
  eventLastOrganizer,
  eventManageNotAllowed,
  eventNotParticipant,
  eventSlugTaken
} from "./errors.js";
import { type MapperDeps, toEventDetail } from "./mappers.js";
import {
  countOrganizers,
  eligibleParticipantIds,
  eventHasMedia,
  existingParticipantIds,
  findEventRoomId,
  listAlbums,
  listParticipants,
  loadVisibleEvent,
  lockVisibleEvent,
  type EventRow,
  type VisibleEvent
} from "./repository.js";

/** The event-access subject of an authenticated caller (role from the database, per request). */
export function eventViewerOf(user: AuthUser): EventViewer {
  return { id: user.id, role: user.role };
}

/**
 * Source of the random slug suffix. A test seam (tests force collisions to
 * exercise the retry cap); production always uses `randomEventSlugSuffix`.
 */
export const slugSuffixSource: { next: () => string } = { next: randomEventSlugSuffix };

const EVENTS_YEAR_SLUG_UNIQUE = "events_year_slug_unique";
const PARTICIPANT_NOT_FOUND = "No encontramos a esa persona en el evento.";
const NOT_ELIGIBLE = "Alguien de la lista no se puede agregar al evento.";
const TOO_MANY_PARTICIPANTS = `El evento puede tener hasta ${EVENT_PARTICIPANTS_MAX} participantes.`;

/** True for a unique violation of `(year, slug)`. */
function isSlugCollision(error: unknown): boolean {
  const info = pgErrorInfo(error);
  return info?.code === PgErrorCode.UniqueViolation && info.constraint === EVENTS_YEAR_SLUG_UNIQUE;
}

function validationError(issue: { path: string; message: string }): AppError {
  return new AppError("VALIDATION", issue.message, { details: [issue] });
}

/** 403 unless the caller organizes the event or is an admin. */
export function requireManager(event: VisibleEvent, viewer: EventViewer): void {
  if (!isEventAdmin(viewer) && event.viewerRole !== EventRole.Organizer) throw eventManageNotAllowed();
}

/** 403 unless the caller takes part in the event or is an admin (chat and albums). */
export function requireEventAccess(event: VisibleEvent, viewer: EventViewer): void {
  if (!isEventAdmin(viewer) && event.viewerRole === null) throw eventNotParticipant();
}

/* -------------------------------------------------------------------------- */
/* Detail                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Build the detail of a visible event for `viewer`. Audits an admin's view
 * of a `participants` event first (fails the read if the audit fails).
 *
 * @param audit - Record `event.admin_viewed` (`detail`) for this read (GET only).
 */
export async function buildEventDetail(
  app: FastifyInstance,
  viewer: EventViewer,
  event: VisibleEvent,
  audit: { ip: string } | null = null
): Promise<EventDetail> {
  if (audit !== null) {
    await auditAdminEventView(app.db, {
      viewer,
      eventId: event.row.id,
      surface: AdminViewSurface.Detail,
      ip: audit.ip,
      now: app.clock.now()
    });
  }
  const [participants, albums, chatRoomId, organizerCount, hasMedia] = await Promise.all([
    listParticipants(app.db, event.row.id, EVENT_PARTICIPANTS_MAX),
    listAlbums(app.db, event.row.id, viewer.id),
    findEventRoomId(app.db, event.row.id),
    countOrganizers(app.db, event.row.id),
    eventHasMedia(app.db, event.row.id)
  ]);
  return toEventDetail(app as MapperDeps, event, viewer, { participants, albums, chatRoomId, organizerCount, hasMedia });
}

/** Re-load the event (visible to `viewer`) and build its detail (after a write). */
export async function eventDetailById(app: FastifyInstance, viewer: EventViewer, eventId: string): Promise<EventDetail> {
  const event = await loadVisibleEvent(app.db, viewer, eq(events.id, eventId));
  return buildEventDetail(app, viewer, event);
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

/** The stored date fields after the merged-row check. */
interface DateFields {
  year: number;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string;
}

/**
 * Run `eventDatesIssue` on the row as it would be written and derive `year`
 * from `startsAt` in the timezone when dated.
 *
 * @throws AppError VALIDATION with the issue as detail.
 */
function checkedDates(row: { year: number | null; startsAt: string | null; endsAt: string | null; timezone: string }): DateFields {
  const issue = eventDatesIssue(row);
  if (issue !== null) throw validationError(issue);
  const year = row.startsAt === null ? row.year : eventYearOf(row.startsAt, row.timezone);
  if (year === null) throw validationError({ path: "year", message: "Elige el año del evento." });
  return {
    year,
    startsAt: row.startsAt === null ? null : new Date(row.startsAt),
    endsAt: row.endsAt === null ? null : new Date(row.endsAt),
    timezone: row.timezone
  };
}

type EventInsert = typeof events.$inferInsert;

/**
 * Insert the event with its slug [SEC]: an admin's typed slug (taken → 409
 * `EVENT_SLUG_TAKEN`), else `memberEventSlug` with a fresh random suffix,
 * retried on a `(year, slug)` collision at most `EVENT_SLUG_MAX_ATTEMPTS`
 * times, then a generic 500 (no slug or collision detail). Each attempt runs
 * in a savepoint so a collision does not abort the transaction.
 */
async function insertEventWithSlug(tx: Transaction, values: Omit<EventInsert, "slug">, typedSlug: string | undefined): Promise<EventRow> {
  const attempt = async (slug: string): Promise<EventRow | null> => {
    try {
      return await tx.transaction(async (savepoint) => {
        const [row] = await savepoint.insert(events).values({ ...values, slug }).returning();
        if (row === undefined) throw new Error("event insert returned no row");
        return row;
      });
    } catch (error) {
      if (isSlugCollision(error)) return null;
      throw error;
    }
  };
  if (typedSlug !== undefined) {
    const row = await attempt(typedSlug);
    if (row === null) throw eventSlugTaken();
    return row;
  }
  for (let tries = 0; tries < EVENT_SLUG_MAX_ATTEMPTS; tries += 1) {
    const row = await attempt(memberEventSlug(values.title, slugSuffixSource.next()));
    if (row !== null) return row;
  }
  throw new Error("event slug: attempts exhausted");
}

/** Create the chat room of a published event (idempotent: one room per event). */
async function ensureEventRoom(tx: Transaction, eventId: string): Promise<void> {
  await tx
    .insert(chatRooms)
    .values({ kind: "event", eventId, title: null })
    .onConflictDoNothing({ target: chatRooms.eventId, where: sql`kind = 'event'` });
}

/**
 * The per-user creation caps (members only) [SEC]: at most
 * {@link EVENT_CREATE_DAILY_MAX} events per rolling day and
 * {@link EVENT_OPEN_DRAFTS_MAX} open drafts. Counted in the database under a
 * per-user advisory lock, so they hold across restarts and concurrent calls.
 */
async function enforceCreateCaps(tx: Transaction, user: AuthUser, now: Date): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`event-create:${user.id}`}))`);
  if (user.role === "admin") return;
  const since = new Date(now.getTime() - EVENT_CREATE_WINDOW_MS);
  const [usage] = await tx
    .select({
      recent: sql<number>`(count(*) filter (where ${events.createdAt} > ${since.toISOString()}::timestamptz))::int`.mapWith(Number),
      drafts: sql<number>`(count(*) filter (where ${events.status} = 'draft'))::int`.mapWith(Number)
    })
    .from(events)
    .where(eq(events.createdByUserId, user.id));
  if ((usage?.recent ?? 0) >= EVENT_CREATE_DAILY_MAX) {
    throw new AppError("RATE_LIMITED", "Ya creaste muchos eventos hoy. Intenta de nuevo mañana.");
  }
  if ((usage?.drafts ?? 0) >= EVENT_OPEN_DRAFTS_MAX) {
    throw new AppError("RATE_LIMITED", "Tienes demasiados borradores. Publica o borra alguno primero.");
  }
}

/**
 * Check the users an organizer (or admin) wants to add and return the new
 * ones [SEC]: everyone must be active and verified, and listed in the
 * directory unless the caller is an admin. One generic 400 for any
 * ineligible id (unknown, unlisted, disabled), so the answer reveals nothing
 * about hidden accounts.
 */
async function newEligibleParticipants(
  tx: Transaction,
  eventId: string | null,
  userIds: readonly string[],
  viewer: EventViewer
): Promise<string[]> {
  const existing = eventId === null ? new Set<string>() : await existingParticipantIds(tx, eventId, userIds);
  const fresh = userIds.filter((id) => !existing.has(id));
  const eligible = await eligibleParticipantIds(tx, fresh, !isEventAdmin(viewer));
  if (eligible.size !== fresh.length) throw validationError({ path: "userIds", message: NOT_ELIGIBLE });
  return fresh;
}

/**
 * `POST /api/events` and `POST /api/admin/events`: create the event (the
 * caller becomes its organizer), its "Fotos" album and, when published, its
 * chat room; optionally add participants.
 *
 * @returns The new event's id.
 */
export async function createEvent(
  app: FastifyInstance,
  user: AuthUser,
  input: CreateEventInput | AdminCreateEventInput,
  ip: string
): Promise<string> {
  const viewer = eventViewerOf(user);
  const now = app.clock.now();
  const typedSlug = "slug" in input ? input.slug : undefined;
  const dates = checkedDates({ year: input.year ?? null, startsAt: input.startsAt, endsAt: input.endsAt, timezone: input.timezone });
  const publish = input.publish;

  const eventId = await app.db.transaction(async (tx) => {
    await enforceCreateCaps(tx, user, now);
    const others = input.participantUserIds.filter((id) => id !== user.id);
    const added = await newEligibleParticipants(tx, null, others, viewer);
    if (added.length + 1 > EVENT_PARTICIPANTS_MAX) throw new AppError("CONFLICT", TOO_MANY_PARTICIPANTS);

    const row = await insertEventWithSlug(
      tx,
      {
        ...dates,
        title: input.title,
        summary: input.summary,
        details: input.details,
        locationText: input.locationText,
        visibility: input.visibility,
        status: publish ? EventStatus.Published : EventStatus.Draft,
        firstPublishedAt: publish ? now : null,
        createdByUserId: user.id
      },
      typedSlug
    );
    await tx.insert(eventParticipants).values([
      { eventId: row.id, userId: user.id, role: EventRole.Organizer, addedByUserId: null },
      ...added.map((userId) => ({ eventId: row.id, userId, role: EventRole.Participant, addedByUserId: user.id }))
    ]);
    await tx.insert(eventAlbums).values({ eventId: row.id, title: DEFAULT_EVENT_ALBUM_TITLE, createdByUserId: user.id });
    if (publish) await ensureEventRoom(tx, row.id);

    const audit = (action: AuditAction, metadata: Record<string, unknown>): Promise<string> =>
      recordAudit(tx, { actorUserId: user.id, action, entityType: AuditEntityType.Event, entityId: row.id, metadata, ip });
    await audit(AuditAction.EventCreated, {
      status: row.status,
      visibility: row.visibility,
      participantCount: added.length + 1,
      typedSlug: typedSlug !== undefined
    });
    if (added.length > 0) await audit(AuditAction.EventParticipantAdded, { userIds: added, role: EventRole.Participant });
    if (publish) await audit(AuditAction.EventPublished, {});
    return row.id;
  });
  return eventId;
}

/* -------------------------------------------------------------------------- */
/* Update                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `PATCH /api/events/:id` and `PATCH /api/admin/events/:id`. Organizers move
 * `draft` ↔ `published`; `hidden` (to or from) is admin-only; the slug only
 * through the admin route. The merged row runs `eventDatesIssue`. Refreshes
 * the chat audience (status/visibility) before returning.
 */
export async function updateEvent(
  app: FastifyInstance,
  user: AuthUser,
  eventId: string,
  patch: AdminUpdateEventInput,
  ip: string
): Promise<void> {
  const viewer = eventViewerOf(user);
  const now = app.clock.now();
  const before = await snapshotEventRoom(app, eventId);
  await app.db.transaction(async (tx) => {
    const event = await lockVisibleEvent(tx, viewer, eventId);
    requireManager(event, viewer);
    const current = event.row;
    const nextStatus = patch.status ?? current.status;
    if ((nextStatus === EventStatus.Hidden || current.status === EventStatus.Hidden) && nextStatus !== current.status) {
      if (!isEventAdmin(viewer)) throw new AppError("FORBIDDEN", "Solo un administrador puede ocultar un evento.");
    }

    const startsAt = patch.startsAt !== undefined ? patch.startsAt : (current.startsAt?.toISOString() ?? null);
    const endsAt = patch.endsAt !== undefined ? patch.endsAt : (current.endsAt?.toISOString() ?? null);
    const timezone = patch.timezone ?? current.timezone;
    const dates = checkedDates({
      year: patch.year ?? (startsAt === null ? current.year : null),
      startsAt,
      endsAt,
      timezone
    });

    const fields = Object.keys(patch).filter((key) => key !== "slug" || patch.slug !== current.slug);
    const publishing = nextStatus === EventStatus.Published && current.status !== EventStatus.Published;
    const values: Partial<EventInsert> = {
      ...dates,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.summary === undefined ? {} : { summary: patch.summary }),
      ...(patch.details === undefined ? {} : { details: patch.details }),
      ...(patch.locationText === undefined ? {} : { locationText: patch.locationText }),
      ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
      status: nextStatus,
      ...(publishing && current.firstPublishedAt === null ? { firstPublishedAt: now } : {}),
      updatedAt: now
    };
    await updateWithSlug(tx, current, values, patch.slug);
    if (publishing) await ensureEventRoom(tx, current.id);

    const audit = (action: AuditAction, metadata: Record<string, unknown>): Promise<string> =>
      recordAudit(tx, { actorUserId: user.id, action, entityType: AuditEntityType.Event, entityId: current.id, metadata, ip });
    await audit(AuditAction.EventUpdated, { fields, status: nextStatus, byAdmin: isEventAdmin(viewer) });
    if (publishing) await audit(AuditAction.EventPublished, {});
    if (nextStatus !== current.status && (nextStatus === EventStatus.Hidden || current.status === EventStatus.Hidden)) {
      await audit(AuditAction.EventHidden, { hidden: nextStatus === EventStatus.Hidden });
    }
  });
  await syncEventRoom(app, eventId, before);
}

/**
 * Update the row. When the year changes, the (unchanged) slug may collide
 * in the new year: an admin-typed slug answers 409; otherwise the slug is
 * regenerated with `memberEventSlug` (same retry cap as create).
 */
async function updateWithSlug(
  tx: Transaction,
  current: EventRow,
  values: Partial<EventInsert>,
  typedSlug: string | undefined
): Promise<void> {
  const write = async (slug: string | undefined): Promise<boolean> => {
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint
          .update(events)
          .set({ ...values, ...(slug === undefined ? {} : { slug }) })
          .where(eq(events.id, current.id));
      });
      return true;
    } catch (error) {
      if (isSlugCollision(error)) return false;
      throw error;
    }
  };
  if (await write(typedSlug)) return;
  if (typedSlug !== undefined) throw eventSlugTaken();
  const title = values.title ?? current.title;
  for (let tries = 0; tries < EVENT_SLUG_MAX_ATTEMPTS; tries += 1) {
    if (await write(memberEventSlug(title, slugSuffixSource.next()))) return;
  }
  throw new Error("event slug: attempts exhausted");
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `DELETE /api/events/:id`: admins always; an organizer only a draft with no
 * media (any media row, soft-deleted included). Album media rows are
 * hard-deleted in the transaction (`album_id` is RESTRICT); their objects,
 * the cover objects and pending cover originals are removed after the
 * commit. Participants, albums, cover uploads and the room cascade.
 */
export async function deleteEvent(app: FastifyInstance, user: AuthUser, eventId: string, ip: string): Promise<void> {
  const viewer = eventViewerOf(user);
  const before = await snapshotEventRoom(app, eventId);
  const objectKeys = await app.db.transaction(async (tx) => {
    const event = await lockVisibleEvent(tx, viewer, eventId);
    const admin = isEventAdmin(viewer);
    if (!admin) {
      if (event.viewerRole !== EventRole.Organizer) throw eventManageNotAllowed();
      if (event.row.status !== EventStatus.Draft || (await eventHasMedia(tx, eventId))) throw eventDeleteNotAllowed();
    }
    const media = await tx
      .select({ item: mediaItems })
      .from(mediaItems)
      .innerJoin(eventAlbums, eq(eventAlbums.id, mediaItems.albumId))
      .where(eq(eventAlbums.eventId, eventId));
    const uploads = await tx
      .select({ id: eventCoverUploads.id, objectKey: eventCoverUploads.objectKey, mimeType: eventCoverUploads.mimeType })
      .from(eventCoverUploads)
      .where(eq(eventCoverUploads.eventId, eventId));
    if (media.length > 0) {
      await tx.delete(mediaItems).where(
        inArray(
          mediaItems.id,
          media.map(({ item }) => item.id)
        )
      );
    }
    await tx.delete(events).where(eq(events.id, eventId));
    await recordAudit(tx, {
      actorUserId: user.id,
      action: AuditAction.EventDeleted,
      entityType: AuditEntityType.Event,
      entityId: eventId,
      metadata: { participantCount: event.participantCount, mediaDeleted: media.length, byAdmin: admin },
      ip
    });
    return [
      ...media.flatMap(({ item }) => allObjectKeys(item, null)),
      ...coverDerivativeKeys(event.row.coverKey),
      ...uploads.flatMap((upload) => {
        const keys = coverKeys(eventId, upload.id, upload.mimeType);
        return [upload.objectKey, keys.w1280, keys.w640];
      })
    ];
  });
  await removeEventRoom(app, before);
  await deleteObjectsQuietly(app, [...new Set(objectKeys)], "event");
}

/* -------------------------------------------------------------------------- */
/* Participants                                                                */
/* -------------------------------------------------------------------------- */

function participantAudit(
  tx: Transaction,
  user: AuthUser,
  eventId: string,
  ip: string
): (action: AuditAction, metadata: Record<string, unknown>) => Promise<string> {
  return (action, metadata) =>
    recordAudit(tx, { actorUserId: user.id, action, entityType: AuditEntityType.Event, entityId: eventId, metadata, ip });
}

/**
 * `POST /api/events/:id/join` ("Me apunto"): published `members` events
 * only (403 `EVENT_JOIN_NOT_ALLOWED` otherwise, admins included).
 * Idempotent. The chat room becomes readable before the answer.
 */
export async function joinEvent(app: FastifyInstance, user: AuthUser, eventId: string, ip: string): Promise<void> {
  const viewer = eventViewerOf(user);
  const before = await snapshotEventRoom(app, eventId);
  await app.db.transaction(async (tx) => {
    const event = await lockVisibleEvent(tx, viewer, eventId);
    if (event.row.status !== EventStatus.Published || event.row.visibility !== "members") throw eventJoinNotAllowed();
    if (event.viewerRole !== null) return;
    if (event.participantCount + 1 > EVENT_PARTICIPANTS_MAX) throw new AppError("CONFLICT", TOO_MANY_PARTICIPANTS);
    await tx.insert(eventParticipants).values({ eventId, userId: user.id, role: EventRole.Participant, addedByUserId: null });
    await participantAudit(tx, user, eventId, ip)(AuditAction.EventJoined, { userId: user.id });
  });
  await syncEventRoom(app, eventId, before);
}

/**
 * `DELETE /api/events/:id/participants/me`: leave. 403
 * `EVENT_NOT_PARTICIPANT` for a non-participant; 409 `EVENT_LAST_ORGANIZER`
 * for the last organizer. The caller gets `room_removed` on their sockets.
 */
export async function leaveEvent(app: FastifyInstance, user: AuthUser, eventId: string, ip: string): Promise<void> {
  const viewer = eventViewerOf(user);
  const before = await snapshotEventRoom(app, eventId);
  await app.db.transaction(async (tx) => {
    const event = await lockVisibleEvent(tx, viewer, eventId);
    if (event.viewerRole === null) throw eventNotParticipant();
    if (event.viewerRole === EventRole.Organizer && (await countOrganizers(tx, eventId)) <= 1) throw eventLastOrganizer();
    await tx
      .delete(eventParticipants)
      .where(and(eq(eventParticipants.eventId, eventId), eq(eventParticipants.userId, user.id)));
    await participantAudit(tx, user, eventId, ip)(AuditAction.EventLeft, { userId: user.id, role: event.viewerRole });
  });
  await syncEventRoom(app, eventId, before);
}

/**
 * `POST /api/events/:id/participants` (organizers, admins): add listed,
 * active, verified members (admins: any active, verified member), up to
 * {@link EVENT_PARTICIPANTS_MAX}. Existing participants are left as they
 * are. Each new participant sees a consent notice (`GET /api/events/notices`).
 */
export async function addParticipants(
  app: FastifyInstance,
  user: AuthUser,
  eventId: string,
  input: AddEventParticipantsInput,
  ip: string
): Promise<void> {
  const viewer = eventViewerOf(user);
  const before = await snapshotEventRoom(app, eventId);
  await app.db.transaction(async (tx) => {
    const event = await lockVisibleEvent(tx, viewer, eventId);
    requireManager(event, viewer);
    const added = await newEligibleParticipants(tx, eventId, input.userIds, viewer);
    if (added.length === 0) return;
    if (event.participantCount + added.length > EVENT_PARTICIPANTS_MAX) throw new AppError("CONFLICT", TOO_MANY_PARTICIPANTS);
    await tx
      .insert(eventParticipants)
      .values(added.map((userId) => ({ eventId, userId, role: input.role, addedByUserId: user.id })));
    await participantAudit(tx, user, eventId, ip)(AuditAction.EventParticipantAdded, { userIds: added, role: input.role });
  });
  await syncEventRoom(app, eventId, before);
}

/** The target participant's role, or 404. */
async function participantRole(tx: Transaction, eventId: string, userId: string): Promise<EventRole> {
  const [row] = await tx
    .select({ role: eventParticipants.role })
    .from(eventParticipants)
    .where(and(eq(eventParticipants.eventId, eventId), eq(eventParticipants.userId, userId)))
    .limit(1);
  if (row === undefined) throw new AppError("NOT_FOUND", PARTICIPANT_NOT_FOUND);
  return row.role;
}

/**
 * `PATCH /api/events/:id/participants/:userId` (organizers, admins):
 * promote or demote; never demotes the last organizer.
 */
export async function changeParticipantRole(
  app: FastifyInstance,
  user: AuthUser,
  eventId: string,
  targetUserId: string,
  role: EventRole,
  ip: string
): Promise<void> {
  const viewer = eventViewerOf(user);
  const before = await snapshotEventRoom(app, eventId);
  await app.db.transaction(async (tx) => {
    const event = await lockVisibleEvent(tx, viewer, eventId);
    requireManager(event, viewer);
    const current = await participantRole(tx, eventId, targetUserId);
    if (current === role) return;
    if (current === EventRole.Organizer && (await countOrganizers(tx, eventId)) <= 1) throw eventLastOrganizer();
    await tx
      .update(eventParticipants)
      .set({ role })
      .where(and(eq(eventParticipants.eventId, eventId), eq(eventParticipants.userId, targetUserId)));
    await participantAudit(tx, user, eventId, ip)(AuditAction.EventParticipantRoleChanged, { userId: targetUserId, role });
  });
  await syncEventRoom(app, eventId, before);
}

/**
 * `DELETE /api/events/:id/participants/:userId` (organizers, admins). The
 * removed user gets `room_removed` before the answer.
 */
export async function removeParticipant(
  app: FastifyInstance,
  user: AuthUser,
  eventId: string,
  targetUserId: string,
  ip: string
): Promise<void> {
  const viewer = eventViewerOf(user);
  const before = await snapshotEventRoom(app, eventId);
  await app.db.transaction(async (tx) => {
    const event = await lockVisibleEvent(tx, viewer, eventId);
    requireManager(event, viewer);
    const current = await participantRole(tx, eventId, targetUserId);
    if (current === EventRole.Organizer && (await countOrganizers(tx, eventId)) <= 1) throw eventLastOrganizer();
    await tx
      .delete(eventParticipants)
      .where(and(eq(eventParticipants.eventId, eventId), eq(eventParticipants.userId, targetUserId)));
    await participantAudit(tx, user, eventId, ip)(AuditAction.EventParticipantRemoved, { userId: targetUserId, role: current });
  });
  await syncEventRoom(app, eventId, before);
}

/* -------------------------------------------------------------------------- */
/* Albums                                                                      */
/* -------------------------------------------------------------------------- */

/** `POST /api/events/:id/albums` (organizers, admins; at most {@link EVENT_ALBUMS_MAX}). */
export async function createAlbum(
  app: FastifyInstance,
  user: AuthUser,
  eventId: string,
  input: CreateEventAlbumInput,
  ip: string
): Promise<string> {
  const viewer = eventViewerOf(user);
  return app.db.transaction(async (tx) => {
    const event = await lockVisibleEvent(tx, viewer, eventId);
    requireManager(event, viewer);
    const [existing] = await tx.select({ value: count() }).from(eventAlbums).where(eq(eventAlbums.eventId, eventId));
    const albums = existing?.value ?? 0;
    if (albums >= EVENT_ALBUMS_MAX) throw new AppError("CONFLICT", `Un evento puede tener hasta ${EVENT_ALBUMS_MAX} álbumes.`);
    const [album] = await tx
      .insert(eventAlbums)
      .values({ eventId, title: input.title, sortOrder: Math.min(albums, EVENT_ALBUM_SORT_ORDER_MAX), createdByUserId: user.id })
      .returning({ id: eventAlbums.id });
    if (album === undefined) throw new Error("album insert returned no row");
    await participantAudit(tx, user, eventId, ip)(AuditAction.EventAlbumCreated, { albumId: album.id });
    return album.id;
  });
}

/** The album row of the event, or 404. */
async function requireAlbum(tx: Transaction, eventId: string, albumId: string): Promise<{ id: string; eventId: string }> {
  const [album] = await tx
    .select({ id: eventAlbums.id, eventId: eventAlbums.eventId })
    .from(eventAlbums)
    .where(and(eq(eventAlbums.id, albumId), eq(eventAlbums.eventId, eventId)))
    .limit(1);
  if (album === undefined) throw albumNotFound();
  return album;
}

/** `PATCH /api/events/:id/albums/:albumId` (organizers, admins). */
export async function updateAlbum(
  app: FastifyInstance,
  user: AuthUser,
  eventId: string,
  albumId: string,
  input: UpdateEventAlbumInput,
  ip: string
): Promise<void> {
  const viewer = eventViewerOf(user);
  await app.db.transaction(async (tx) => {
    const event = await lockVisibleEvent(tx, viewer, eventId);
    requireManager(event, viewer);
    await requireAlbum(tx, eventId, albumId);
    await tx
      .update(eventAlbums)
      .set({ ...input, updatedAt: app.clock.now() })
      .where(eq(eventAlbums.id, albumId));
    await participantAudit(tx, user, eventId, ip)(AuditAction.EventAlbumUpdated, { albumId, fields: Object.keys(input) });
  });
}

/**
 * `DELETE /api/events/:id/albums/:albumId` (organizers, admins): 409
 * `EVENT_ALBUM_NOT_EMPTY` while live media remain; soft-deleted rows are
 * hard-deleted in the transaction and their objects removed after it.
 */
export async function deleteAlbum(
  app: FastifyInstance,
  user: AuthUser,
  eventId: string,
  albumId: string,
  ip: string
): Promise<void> {
  const viewer = eventViewerOf(user);
  const keys = await app.db.transaction(async (tx) => {
    const event = await lockVisibleEvent(tx, viewer, eventId);
    requireManager(event, viewer);
    await requireAlbum(tx, eventId, albumId);
    const rows = await tx.select().from(mediaItems).where(eq(mediaItems.albumId, albumId)).for("update");
    if (rows.some((row) => row.deletedAt === null)) throw eventAlbumNotEmpty();
    if (rows.length > 0) await tx.delete(mediaItems).where(eq(mediaItems.albumId, albumId));
    await tx.delete(eventAlbums).where(eq(eventAlbums.id, albumId));
    await participantAudit(tx, user, eventId, ip)(AuditAction.EventAlbumDeleted, { albumId, purged: rows.length });
    return rows.flatMap((row) => allObjectKeys(row, null));
  });
  await deleteObjectsQuietly(app, [...new Set(keys)], "event album");
}

/**
 * The album's key prefix, re-checked inside the upload intent's locked
 * transaction [SEC]: the event is still visible, the caller still takes
 * part (or is an admin), and the album still belongs to it.
 */
export async function recheckAlbumUpload(tx: Transaction, viewer: EventViewer, eventId: string, albumId: string): Promise<void> {
  const event = await loadVisibleEvent(tx, viewer, eq(events.id, eventId));
  requireEventAccess(event, viewer);
  await requireAlbum(tx, eventId, albumId);
}

/** Pending cover intents of a user that may still be confirmed (cap). */
export async function openCoverIntents(app: FastifyInstance, userId: string): Promise<number> {
  const [open] = await app.db
    .select({ value: count() })
    .from(eventCoverUploads)
    .where(
      and(
        eq(eventCoverUploads.uploadedByUserId, userId),
        isNull(eventCoverUploads.confirmedAt),
        gt(eventCoverUploads.expiresAt, app.clock.now())
      )
    );
  return open?.value ?? 0;
}
