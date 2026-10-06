/**
 * Cross-tab logout over `BroadcastChannel('cuencada-auth')`.
 *
 * Logging out in one tab logs out every other tab of the same origin, so a
 * family member on a shared computer does not leave a live session in a
 * forgotten tab. Only a well-formed `{ type: "logout" }` message is acted on.
 */
import type { Dispatch } from "@reduxjs/toolkit";
import { loggedOut } from "./authSlice";

/** Channel name shared by every tab. */
export const AUTH_CHANNEL_NAME = "cuencada-auth";

/** The only message the auth channel carries. It never includes tokens or user data. */
export interface AuthLogoutMessage {
  type: "logout";
}

let activeChannel: BroadcastChannel | null = null;

function isLogoutMessage(data: unknown): data is AuthLogoutMessage {
  return typeof data === "object" && data !== null && "type" in data && data.type === "logout";
}

/**
 * Starts listening for logouts from other tabs. Call once at boot.
 * No-op where `BroadcastChannel` is unavailable.
 *
 * @param dispatch - The store's dispatch.
 * @returns A function that stops listening and closes the channel.
 */
export function startAuthSync(dispatch: Dispatch): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;

  const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (isLogoutMessage(event.data)) dispatch(loggedOut());
  };
  activeChannel = channel;

  return () => {
    channel.close();
    if (activeChannel === channel) activeChannel = null;
  };
}

/**
 * Tells every other tab to log out. The sending tab does not receive its own
 * message, so it must dispatch `loggedOut` itself (the `logout` thunk does).
 */
export function broadcastLogout(): void {
  const message: AuthLogoutMessage = { type: "logout" };
  activeChannel?.postMessage(message);
}
