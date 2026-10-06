/**
 * Who the RSVP UI is for, and whether an attendee row is the current user.
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
 * The contract's `Attendee` has no `isMe` flag yet (see WP-T3-FE Requests),
 * so match on the user id, or on the linked person for attendance-only rows.
 *
 * @param attendee - One attendee row.
 * @param user - The current user.
 * @returns Whether the row is the current user.
 */
export function isMe(attendee: Attendee, user: Pick<CurrentUser, "id" | "personId">): boolean {
  if (attendee.userId !== null && attendee.userId === user.id) return true;
  return attendee.personId !== null && user.personId !== null && attendee.personId === user.personId;
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
