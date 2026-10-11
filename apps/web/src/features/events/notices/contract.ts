/**
 * The consent-notice contract of WP-5.3 (`packages/types/src/events.ts` on
 * `wp/5.3-events-server`: `EventNotice`, `eventNoticeListSchema`,
 * `EVENT_NOTICES_MAX`), copied here shape for shape because WP-5.3 is not on
 * main yet. When it merges, delete this file and import the names from
 * `@cuencada/types` (`eventNoticeListSchema.parse` replaces
 * {@link parseEventNoticeList}).
 *
 * - `GET /api/events/notices`: undismissed "someone else added you" notices,
 *   only for events the caller can see, newest first.
 * - `DELETE /api/events/:id/notice`: "Entendido" (204, idempotent).
 * - "Salir" is `DELETE /api/events/:id/participants/me`.
 */
import { dateTimeSchema, type EventRef, type EventRole, eventRefSchema, eventRoleSchema } from "@cuencada/types";

/** "Te agregaron a un evento". */
export interface EventNotice {
  event: EventRef;
  /** Who added the caller; `null` once that account was removed. */
  addedByName: string | null;
  /** The role the caller was given. */
  role: EventRole;
  addedAt: string;
  /** False when the caller is the event's last organizer (they cannot leave). */
  canLeave: boolean;
}

/** Most notices returned by `GET /api/events/notices` (newest first). */
export const EVENT_NOTICES_MAX = 20;

/** `GET /api/events/notices` response. */
export interface EventNoticeList {
  items: EventNotice[];
}

function parseNotice(raw: unknown): EventNotice | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record: Record<string, unknown> = { ...raw };
  const event = eventRefSchema.safeParse(record.event);
  const role = eventRoleSchema.safeParse(record.role);
  const addedAt = dateTimeSchema.safeParse(record.addedAt);
  const addedByName = record.addedByName;
  const nameOk = addedByName === null || (typeof addedByName === "string" && addedByName.length <= 80);
  if (!event.success || !role.success || !addedAt.success || !nameOk || typeof record.canLeave !== "boolean") return null;
  return {
    event: event.data,
    addedByName: typeof addedByName === "string" ? addedByName : null,
    role: role.data,
    addedAt: addedAt.data,
    canLeave: record.canLeave
  };
}

/**
 * The web's stand-in for `eventNoticeListSchema.parse` (the web has no
 * direct zod dependency; the event part reuses WP-5.2's `eventRefSchema`).
 * Malformed items are dropped, never rendered; more than
 * {@link EVENT_NOTICES_MAX} are cut.
 *
 * @param raw - The response body.
 * @returns The valid notices.
 */
export function parseEventNoticeList(raw: unknown): EventNoticeList {
  if (typeof raw !== "object" || raw === null || !("items" in raw) || !Array.isArray(raw.items)) return { items: [] };
  const items: unknown[] = raw.items;
  return { items: items.slice(0, EVENT_NOTICES_MAX).flatMap((item) => parseNotice(item) ?? []) };
}
