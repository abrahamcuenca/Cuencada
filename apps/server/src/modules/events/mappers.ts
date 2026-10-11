/**
 * Row → contract mappers for events. Only ever called with events the
 * caller may see (the repository filtered them), so presigning the cover
 * here never hands a URL to someone who cannot see the event (Security
 * requirement 8).
 *
 * [SEC] Participant privacy (requirement 4, ADR 0001 §7): `userId` only for
 * the caller's own row, for callers who manage the event, and for listed,
 * active members; `avatarUrl` only for the caller and listed, active members
 * (the directory's rule), never an email or contact.
 */
import {
  type AdminEventSummary,
  type EventAlbum,
  type EventDetail,
  type EventParticipant,
  EventRole,
  EventStatus,
  type EventSummary,
  EventVisibility
} from "@cuencada/types";
import type { FastifyBaseLogger } from "fastify";
import type { StorageService } from "../../lib/storage/types.js";
import { VIEW_URL_SECONDS } from "../media/constants.js";
import { AvatarSize, avatarUrlFor } from "../profile/index.js";
import { errorName } from "../profile/shared.js";
import { type EventViewer, isEventAdmin } from "./access.js";
import { coverKeyForWidth } from "./cover.js";
import type { AdminEventRecord, AlbumRecord, EventRow, ParticipantRecord, VisibleEvent } from "./repository.js";

/** Storage and logger. */
export interface MapperDeps {
  storage: Pick<StorageService, "presignGet">;
  log: Pick<FastifyBaseLogger, "warn">;
}

async function presignQuietly(deps: MapperDeps, key: string | null): Promise<string | null> {
  if (key === null) return null;
  try {
    const signed = await deps.storage.presignGet({ key, expiresInSeconds: VIEW_URL_SECONDS });
    return signed.url;
  } catch (error) {
    deps.log.warn({ errorName: errorName(error) }, "event presign failed");
    return null;
  }
}

/** The caller's capabilities on a visible event. */
export interface EventFlags {
  canManage: boolean;
  canJoin: boolean;
  hasChat: boolean;
}

/** Flags from the caller's role (ADR 0001 §7). */
export function flagsFor(row: EventRow, viewerRole: EventRole | null, viewer: EventViewer): EventFlags {
  const admin = isEventAdmin(viewer);
  return {
    canManage: admin || viewerRole === EventRole.Organizer,
    canJoin: viewerRole === null && row.status === EventStatus.Published && row.visibility === EventVisibility.Members,
    hasChat: admin || viewerRole !== null
  };
}

/**
 * A list card (cover 640 px) or the summary part of a detail (cover 1280 px).
 *
 * @param width - Which cover derivative to presign.
 */
export async function toEventSummary(
  deps: MapperDeps,
  event: Pick<VisibleEvent, "row" | "viewerRole" | "participantCount">,
  viewer: EventViewer,
  width: 1280 | 640
): Promise<EventSummary> {
  const { row, viewerRole } = event;
  const flags = flagsFor(row, viewerRole, viewer);
  return {
    id: row.id,
    year: row.year,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    timezone: row.timezone,
    locationText: row.locationText,
    coverUrl: await presignQuietly(deps, coverKeyForWidth(row.coverKey, width)),
    visibility: row.visibility,
    status: row.status,
    participantCount: event.participantCount,
    viewerRole,
    ...flags
  };
}

/** Map one participant for `viewer` (privacy rules in the module doc). */
export async function toEventParticipant(
  deps: MapperDeps,
  record: ParticipantRecord,
  viewer: EventViewer,
  canManage: boolean
): Promise<EventParticipant> {
  const isSelf = record.userId === viewer.id;
  const listedActive = record.listedInDirectory && record.userStatus === "active";
  const showAvatar = isSelf || listedActive;
  return {
    ...(isSelf || canManage || listedActive ? { userId: record.userId } : {}),
    displayName: record.displayName,
    avatarUrl: showAvatar ? await avatarUrlFor(deps, record.avatarKey, AvatarSize.Small) : null,
    role: record.role,
    joinedAt: record.joinedAt.toISOString(),
    isSelf
  };
}

/** Map an album (thumbnail presigned only for callers with album access). */
export async function toEventAlbum(deps: MapperDeps, record: AlbumRecord): Promise<EventAlbum> {
  return {
    id: record.id,
    eventId: record.eventId,
    title: record.title,
    sortOrder: record.sortOrder,
    mediaCount: record.mediaCount,
    coverThumbUrl: await presignQuietly(deps, record.coverThumbKey),
    createdAt: record.createdAt.toISOString()
  };
}

/** Everything {@link toEventDetail} needs beyond the event. */
export interface DetailParts {
  participants: ParticipantRecord[];
  albums: AlbumRecord[];
  chatRoomId: string | null;
  organizerCount: number;
  hasMedia: boolean;
}

/**
 * The detail for `viewer`: albums and the room id only with chat/album
 * access (participants and admins), `canDelete`/`canLeave` per §7.
 */
export async function toEventDetail(
  deps: MapperDeps,
  event: VisibleEvent,
  viewer: EventViewer,
  parts: DetailParts
): Promise<EventDetail> {
  const summary = await toEventSummary(deps, event, viewer, 1280);
  const { row, viewerRole } = event;
  const admin = isEventAdmin(viewer);
  const isOrganizer = viewerRole === EventRole.Organizer;
  const participants = await Promise.all(
    parts.participants.map((record) => toEventParticipant(deps, record, viewer, summary.canManage))
  );
  const albums = summary.hasChat ? await Promise.all(parts.albums.map((album) => toEventAlbum(deps, album))) : [];
  return {
    ...summary,
    details: row.details,
    firstPublishedAt: row.firstPublishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    participants,
    albums,
    chatRoomId: summary.hasChat ? parts.chatRoomId : null,
    canDelete: admin || (isOrganizer && row.status === EventStatus.Draft && !parts.hasMedia),
    canLeave: viewerRole !== null && !(isOrganizer && parts.organizerCount <= 1)
  };
}

/** An admin list row. */
export async function toAdminEventSummary(
  deps: MapperDeps,
  record: AdminEventRecord,
  viewer: EventViewer
): Promise<AdminEventSummary> {
  const summary = await toEventSummary(deps, record, viewer, 640);
  return {
    ...summary,
    createdByUserId: record.row.createdByUserId,
    createdByName: record.createdByName,
    firstPublishedAt: record.row.firstPublishedAt?.toISOString() ?? null,
    mediaCount: record.mediaCount,
    createdAt: record.row.createdAt.toISOString()
  };
}
