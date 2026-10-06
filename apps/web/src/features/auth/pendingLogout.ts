/**
 * Durable "logout not yet confirmed by the server" marker [SEC].
 *
 * When `POST /auth/logout` cannot reach the server, the HttpOnly refresh
 * cookie is still valid and JS cannot delete it. Without this marker the next
 * boot refresh would silently log the previous user back in (e.g. a shared
 * family tablet on hotel Wi-Fi). The marker holds only a timestamp: no token,
 * no user data.
 */

/** localStorage key. The value is the ISO time of the unconfirmed logout. */
export const PENDING_LOGOUT_KEY = "cuencada-pending-logout";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Site data blocked: nothing can be persisted, the in-memory retry still runs.
    return null;
  }
}

/** Records that a logout still needs the server's confirmation. */
export function markPendingLogout(): void {
  try {
    storage()?.setItem(PENDING_LOGOUT_KEY, new Date().toISOString());
  } catch {
    // Quota or privacy mode; the in-memory online retry still covers this tab.
  }
}

/** @returns Whether an unconfirmed logout is recorded on this device. */
export function hasPendingLogout(): boolean {
  const target = storage();
  return target !== null && target.getItem(PENDING_LOGOUT_KEY) !== null;
}

/** Forgets the marker after the server confirmed the logout (or a new login replaced the cookie). */
export function clearPendingLogout(): void {
  storage()?.removeItem(PENDING_LOGOUT_KEY);
}
