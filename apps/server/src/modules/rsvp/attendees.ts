/**
 * Attendee strip: union of `yes` RSVPs and historical attendance,
 * deduplicated by person (by user for accounts without a linked person).
 *
 * Privacy: only a display name and an avatar URL leave this module; no
 * contact fields are ever selected. A person whose account has
 * `profiles.listed_in_directory = false` is anonymized for everyone but
 * themselves: name "Familiar", no avatar, no ids. They still count.
 */
import { type Attendee, AttendeeSource, RsvpStatus } from "@cuencada/types";
import type { FastifyBaseLogger } from "fastify";
import { isAppError } from "../../lib/errors.js";
import type { StorageService } from "../../lib/storage/types.js";
import type { AttendeeCandidate } from "./repository.js";

/** Avatar URLs live as long as the gallery's view URLs (1 h). */
export const AVATAR_URL_SECONDS = 60 * 60;

/**
 * Name shown for unlisted accounts (and as a fallback when a person has no
 * usable name, which NOT NULL `full_name` should prevent).
 */
export const ANONYMOUS_NAME = "Familiar";

/** A deduplicated (and, where needed, anonymized) attendee before the avatar is signed. */
export interface MergedAttendee {
  personId: string | null;
  userId: string | null;
  displayName: string;
  avatarKey: string | null;
  source: AttendeeSource;
  isMe: boolean;
}

function keyOf(candidate: AttendeeCandidate): string | null {
  if (candidate.personId !== null) return `p:${candidate.personId}`;
  if (candidate.userId !== null) return `u:${candidate.userId}`;
  return null;
}

function nameOf(candidate: AttendeeCandidate): string {
  return candidate.accountName ?? candidate.nickname ?? candidate.fullName ?? ANONYMOUS_NAME;
}

/**
 * Merge RSVP and attendance candidates. A person who both RSVP'd `yes` and
 * has an attendance record appears once, with `source: rsvp`. Unlisted
 * accounts other than the viewer are anonymized **before** sorting, so their
 * position in the list does not hint at their real name. Sorted by display
 * name (Spanish collation, accent-insensitive), then id.
 *
 * @param rsvps - `yes` RSVP candidates (active accounts).
 * @param attendance - Historical attendance candidates.
 * @param viewerId - Caller: their own row is never anonymized.
 */
export function mergeAttendees(
  rsvps: readonly AttendeeCandidate[],
  attendance: readonly AttendeeCandidate[],
  viewerId: string
): MergedAttendee[] {
  const merged = new Map<string, MergedAttendee>();
  const add = (candidate: AttendeeCandidate, source: AttendeeSource): void => {
    const key = keyOf(candidate);
    if (key === null || merged.has(key)) return;
    const isMe = candidate.userId !== null && candidate.userId === viewerId;
    const hidden = candidate.listedInDirectory === false && !isMe;
    merged.set(
      key,
      hidden
        ? { personId: null, userId: null, displayName: ANONYMOUS_NAME, avatarKey: null, source, isMe }
        : {
            personId: candidate.personId,
            userId: candidate.userId,
            displayName: nameOf(candidate),
            avatarKey: candidate.avatarKey,
            source,
            isMe
          }
    );
  };
  // RSVPs first so they win the dedupe.
  for (const candidate of rsvps) add(candidate, AttendeeSource.Rsvp);
  for (const candidate of attendance) add(candidate, AttendeeSource.Attendance);

  const collator = new Intl.Collator("es", { sensitivity: "base" });
  return [...merged.values()].sort(
    (a, b) =>
      collator.compare(a.displayName, b.displayName) ||
      (a.personId ?? a.userId ?? "").localeCompare(b.personId ?? b.userId ?? "")
  );
}

/**
 * Presign each avatar and map to the contract. When object storage is not
 * configured (503 from the storage service), avatars degrade to `null` with
 * one warning instead of failing the whole list.
 *
 * @param attendees - From {@link mergeAttendees}.
 * @param storage - `app.storage`.
 * @param log - Request logger.
 */
export async function toAttendees(
  attendees: readonly MergedAttendee[],
  storage: StorageService,
  log: FastifyBaseLogger
): Promise<Attendee[]> {
  let storageDown = false;
  const sign = async (key: string | null): Promise<string | null> => {
    if (key === null || storageDown) return null;
    try {
      return (await storage.presignGet({ key, expiresInSeconds: AVATAR_URL_SECONDS })).url;
    } catch (error) {
      if (isAppError(error) && error.code === "SERVICE_UNAVAILABLE") {
        if (!storageDown) log.warn("attendees: object storage unavailable; avatars omitted");
        storageDown = true;
        return null;
      }
      throw error;
    }
  };
  const urls = await Promise.all(attendees.map((attendee) => sign(attendee.avatarKey)));
  return attendees.map((attendee, index) => ({
    personId: attendee.personId,
    userId: attendee.userId,
    displayName: attendee.displayName,
    avatarUrl: urls[index] ?? null,
    source: attendee.source,
    rsvpStatus: attendee.source === AttendeeSource.Rsvp ? RsvpStatus.Yes : null,
    isMe: attendee.isMe
  }));
}
