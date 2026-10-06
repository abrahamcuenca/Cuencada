/**
 * Who the RSVP UI is for, plus small attendee-row helpers. "Is this me?" is
 * the server's `Attendee.isMe`.
 */
import type { Attendee, CurrentUser } from "@cuencada/types";
import { useAppSelector } from "../../../app/hooks";
import { selectAuthStatus, selectCurrentUser, selectPasswordChangeRequired } from "../../auth/authSlice";

/**
 * @returns The logged-in user when they may see member content (password
 * already changed), otherwise `null`. UX only: the API enforces access.
 */
export function useMember(): CurrentUser | null {
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  const mustChange = useAppSelector(selectPasswordChangeRequired);
  return status === "authenticated" && user !== null && !mustChange ? user : null;
}

/**
 * @param attendee - One attendee row.
 * @param index - Its position, used when it has neither id.
 * @returns A stable React key.
 */
export function attendeeKey(attendee: Attendee, index: number): string {
  return attendee.personId ?? attendee.userId ?? `row-${index}`;
}

/**
 * Avatar URLs come from the API (presigned). Only `https:` (or same-origin
 * paths) are rendered, as defence in depth.
 *
 * @param url - The attendee's `avatarUrl`.
 * @returns The URL to render, or `undefined` for the initials fallback.
 */
export function safeAvatarUrl(url: string | null): string | undefined {
  if (url === null) return undefined;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  return url.startsWith("https://") ? url : undefined;
}
