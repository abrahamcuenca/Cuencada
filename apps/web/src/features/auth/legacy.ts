/** localStorage key written by the removed fake "Demo admin" login of the scaffold. */
export const LEGACY_DEMO_USER_KEY = "cuencada-demo-user";

/**
 * Deletes the scaffold's fake session (a full user object, admin role
 * included) from localStorage. Nothing reads it any more; removing it keeps
 * stale "admin" data off shared devices.
 *
 * @param storage - Defaults to `window.localStorage`.
 * @returns `true` when a stale entry was removed.
 */
export function removeLegacyDemoSession(storage?: Storage): boolean {
  let target: Storage;
  try {
    target = storage ?? window.localStorage;
  } catch {
    // Accessing localStorage throws when site data is blocked; then there is nothing to clean.
    return false;
  }
  if (target.getItem(LEGACY_DEMO_USER_KEY) === null) return false;
  target.removeItem(LEGACY_DEMO_USER_KEY);
  return true;
}
