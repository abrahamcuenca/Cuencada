/**
 * "Instalar app" helpers: dismissal flag, standalone and iOS detection.
 * The dismissal is a non-sensitive UI preference, so localStorage is fine.
 */

/** localStorage key holding the install card dismissal ("1"). */
export const INSTALL_DISMISSED_KEY = "cuencada-install-dismissed";

/** @returns Whether the user closed the install card on this device. */
export function isInstallDismissed(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_DISMISSED_KEY) === "1";
  } catch {
    // Storage blocked (private mode, policy): treat as not dismissed; the card stays closable per visit.
    return false;
  }
}

/** Remembers that the user closed the install card. Best effort. */
export function dismissInstall(): void {
  try {
    window.localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
  } catch {
    // Storage blocked: the card closes for this visit only (component state).
  }
}

/** @returns Whether the app already runs installed (home screen / standalone window). */
export function isStandalone(): boolean {
  // Safari-only `navigator.standalone` is missing from the DOM lib; it is optional, so the widening is safe.
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const displayStandalone =
    typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  return iosStandalone || displayStandalone;
}

/** The navigator fields {@link isIosDevice} reads (injectable for tests). */
export interface DeviceHints {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

/**
 * iPhone/iPad (including iPadOS, which reports a Mac user agent). iOS has no
 * `beforeinstallprompt`: the card shows the "Compartir → Agregar a inicio" hint.
 *
 * @param hints - Defaults to the real `navigator`.
 * @returns Whether to show the iOS hint.
 */
export function isIosDevice(hints: DeviceHints = navigator): boolean {
  if (/iPhone|iPad|iPod/.test(hints.userAgent)) return true;
  return hints.platform === "MacIntel" && hints.maxTouchPoints > 1;
}
