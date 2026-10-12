/**
 * Spanish wording, tap-through links and day groups of the notifications
 * feed (WP-6.1). Never renders a comment body or a resolution note (the
 * contract carries neither).
 */
import type { Notification as AppNotification, NotificationMediaPlace } from "@cuencada/types";
import { toZonedParts } from "../../../shared/lib/dates";

/** Shown when the actor's account no longer exists. */
const SOMEONE = "Alguien";

function actorName(notification: AppNotification): string {
  return notification.actor?.name ?? SOMEONE;
}

/** "Ana" or "Ana y 2 más" (the latest actor plus the others coalesced into the row). */
function actorsPhrase(notification: AppNotification): string {
  const name = actorName(notification);
  return notification.count > 1 ? `${name} y ${notification.count - 1} más` : name;
}

/**
 * @param notification - A feed entry.
 * @returns The sentence, e.g. "Ana y 2 más comentaron tu foto".
 */
export function notificationText(notification: AppNotification): string {
  const many = notification.count > 1;
  switch (notification.kind) {
    case "photo_tag_request":
      return notification.actor === null ? "Te etiquetaron en una foto" : `${actorName(notification)} te etiquetó en una foto`;
    case "photo_commented":
      return `${actorsPhrase(notification)} ${many ? "comentaron" : "comentó"} tu foto`;
    case "photo_liked":
      return `A ${actorsPhrase(notification)} ${many ? "les" : "le"} gustó tu foto`;
    case "event_added": {
      const title = notification.target.kind === "event" ? `«${notification.target.event.title}»` : "un evento";
      return notification.actor === null ? `Te agregaron a ${title}` : `${actorName(notification)} te agregó a ${title}`;
    }
    case "tree_proposal_resolved": {
      const approved = notification.target.kind === "proposal" && notification.target.status === "approved";
      return `Tu propuesta del árbol fue ${approved ? "aprobada" : "rechazada"}`;
    }
  }
}

/**
 * @param notification - A feed entry.
 * @returns The secondary line, or `null` (e.g. the tag request's call to action).
 */
export function notificationHint(notification: AppNotification): string | null {
  if (notification.kind === "photo_tag_request") return "Ábrela para aprobar o rechazar la etiqueta.";
  return null;
}

/** An emoji for entries without an actor avatar. */
export function notificationIcon(notification: AppNotification): string {
  switch (notification.kind) {
    case "photo_tag_request":
      return "🏷️";
    case "photo_commented":
      return "💬";
    case "photo_liked":
      return "❤️";
    case "event_added":
      return "🎉";
    case "tree_proposal_resolved":
      return "🌳";
  }
}

/**
 * Where a photo opens: its own page with `?foto=<id>` (WP-6.2's lightbox
 * deep link; without it the page simply opens).
 */
function mediaPath(place: NotificationMediaPlace, mediaId: string): string {
  const foto = `foto=${encodeURIComponent(mediaId)}`;
  switch (place.kind) {
    case "edition":
      return `/galeria/${place.year}?${foto}`;
    case "album":
      return `/eventos/${place.event.year}/${encodeURIComponent(place.event.slug)}?vista=fotos&${foto}`;
    case "memory":
      return `/recuerdos/${encodeURIComponent(place.memoryAlbumId)}?${foto}`;
  }
}

/**
 * @param notification - A feed entry.
 * @returns The in-app path the entry opens: the photo, the event or the proposal.
 */
export function notificationHref(notification: AppNotification): string {
  const { target } = notification;
  switch (target.kind) {
    case "media":
      return mediaPath(target.place, target.mediaId);
    case "event":
      return `/eventos/${target.event.year}/${encodeURIComponent(target.event.slug)}`;
    case "proposal":
      // WP-6.4 owns the proposal view; the family tree is the fallback.
      return `/arbol?propuesta=${encodeURIComponent(target.proposalId)}`;
  }
}

/** A titled run of entries. */
export interface NotificationGroup {
  key: "hoy" | "ayer" | "semana" | "antes";
  label: string;
  items: AppNotification[];
}

const GROUP_LABELS: Record<NotificationGroup["key"], string> = {
  hoy: "Hoy",
  ayer: "Ayer",
  semana: "Esta semana",
  antes: "Anteriores"
};

function dayNumber(value: Date | string, timeZone: string): number {
  const parts = toZonedParts(value, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

/**
 * Groups the feed (already newest first) by day in the reader's timezone.
 *
 * @param items - Feed entries, newest first.
 * @param now - The current time.
 * @param timeZone - The reader's timezone.
 * @returns Non-empty groups in order.
 */
export function groupNotifications(items: readonly AppNotification[], now: Date, timeZone: string): NotificationGroup[] {
  const today = dayNumber(now, timeZone);
  const groups: NotificationGroup[] = [];
  for (const item of items) {
    const diff = today - dayNumber(item.createdAt, timeZone);
    const key: NotificationGroup["key"] = diff <= 0 ? "hoy" : diff === 1 ? "ayer" : diff < 7 ? "semana" : "antes";
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, label: GROUP_LABELS[key], items: [item] });
  }
  return groups;
}
