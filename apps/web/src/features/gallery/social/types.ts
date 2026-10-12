/**
 * Shared state shapes between `GalleryLightbox` (eager inside the gallery
 * chunk) and the lazy social module (`LightboxSocial`), so the lightbox can
 * hold the state without importing the lazy code.
 */

/** Which social sheet is open over the lightbox. */
export type SocialSheet = "comments" | "likers" | "tag";

/** A tag position as a fraction of the image (0–1, both axes). */
export interface TagPoint {
  x: number;
  y: number;
}
