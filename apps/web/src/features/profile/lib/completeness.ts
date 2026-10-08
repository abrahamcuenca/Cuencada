import type { OwnProfile } from "@cuencada/types";

/** Contact fields of {@link OwnProfile.contacts} that count as "a way to reach me". */
const CONTACT_KEYS = ["whatsapp", "instagram", "facebook", "tiktok", "linkedin", "github", "website"] as const;

/**
 * Whether the profile still lacks both a photo and any contact (phone,
 * WhatsApp, a network or a website). The account email does not count: every
 * member has one. Drives Home's "Completa tu perfil" card (WP-4.7).
 *
 * @param profile - The caller's own profile.
 * @returns `true` when there is no avatar and no contact at all.
 */
export function needsProfileCompletion(profile: Pick<OwnProfile, "avatarUrl" | "phone" | "contacts">): boolean {
  if (profile.avatarUrl !== null) return false;
  if (hasText(profile.phone)) return false;
  const contacts = profile.contacts;
  return contacts === undefined || CONTACT_KEYS.every((key) => !hasText(contacts[key]));
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** localStorage key prefix of the card's dismissal; the user id follows it. */
export const PROFILE_PROMPT_DISMISSED_PREFIX = "cuencada-profile-prompt-dismissed:";

/**
 * @param userId - The logged-in user's id (opaque UUID, not PII).
 * @returns Whether this user closed the card on this device.
 */
export function isProfilePromptDismissed(userId: string): boolean {
  try {
    return window.localStorage.getItem(PROFILE_PROMPT_DISMISSED_PREFIX + userId) === "1";
  } catch {
    // Storage blocked (private mode, policy): not dismissed; the card still closes for this visit.
    return false;
  }
}

/**
 * Remembers, per user and device, that the card was closed. Best effort.
 *
 * @param userId - The logged-in user's id.
 */
export function dismissProfilePrompt(userId: string): void {
  try {
    window.localStorage.setItem(PROFILE_PROMPT_DISMISSED_PREFIX + userId, "1");
  } catch {
    // Storage blocked: the card closes for this visit only (component state).
  }
}
