/**
 * Unread total for the "Chat" tab badge (AppLayout).
 *
 * Lightweight on purpose: it pulls only `api.ts`/`events.ts` into the
 * initial chunk, never the socket. Requests happen only for a signed-in
 * member who can use the chat: none when logged out, during the forced
 * password change, or for an unverified email (the server answers 403 there).
 * Outside `/chat` the count is refreshed by polling while the tab is focused;
 * inside, the socket keeps the same cache entry live.
 */
import { useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import { chatApi, useGetRoomsQuery } from "./api";
import { UNREAD_COUNT_MAX } from "./lib/limits";
import { totalUnread } from "./lib/rooms";

/** How often the badge refreshes outside the chat routes. */
export const CHAT_UNREAD_POLL_MS = 120_000;

/** The badge to show on the "Chat" tab. */
export interface ChatUnreadBadge {
  /** Total unread messages (0 hides the badge). */
  count: number;
  /** Screen-reader text, e.g. "3 mensajes sin leer". */
  label: string | undefined;
}

/**
 * @param state - The store state.
 * @returns Whether the signed-in user may load chat data at all (UX gate; the server decides).
 */
export function selectCanUseChat(state: RootState): boolean {
  const { auth } = state;
  return auth.status === "authenticated" && auth.user !== null && !auth.passwordChangeRequired && auth.user.emailVerified;
}

const selectRoomsResult = chatApi.endpoints.getRooms.select();

/**
 * @param count - Unread messages.
 * @returns "1 mensaje sin leer" / "3 mensajes sin leer".
 */
export function unreadLabel(count: number): string {
  if (count >= UNREAD_COUNT_MAX) return `Más de ${UNREAD_COUNT_MAX} mensajes sin leer`;
  return count === 1 ? "1 mensaje sin leer" : `${count} mensajes sin leer`;
}

/**
 * @param count - A room's unread count (the server caps it at 999).
 * @returns The badge text: the number, or "999+" at the cap.
 */
export function unreadCountText(count: number): string {
  return count >= UNREAD_COUNT_MAX ? `${UNREAD_COUNT_MAX}+` : String(count);
}

/**
 * @returns The unread total for the signed-in member, kept fresh by polling
 * (paused while the window is unfocused, stopped after a 403).
 */
export function useChatUnreadBadge(): ChatUnreadBadge {
  const canUseChat = useAppSelector(selectCanUseChat);
  // A 403 (unverified, or chat disabled for this account) will not fix itself by polling.
  const forbidden = useAppSelector((state) => {
    const { error } = selectRoomsResult(state);
    return error !== undefined && "status" in error && error.status === 403;
  });
  const { data } = useGetRoomsQuery(undefined, {
    skip: !canUseChat,
    pollingInterval: forbidden ? 0 : CHAT_UNREAD_POLL_MS,
    skipPollingIfUnfocused: true
  });
  const count = canUseChat ? totalUnread(data) : 0;
  return { count, label: count > 0 ? unreadLabel(count) : undefined };
}
