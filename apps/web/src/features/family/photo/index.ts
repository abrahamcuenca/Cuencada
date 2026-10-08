/**
 * Photos with crop (WP-4.3). Public surface for the person page (WP-4.1)
 * and the profile's avatar editor:
 * - `PersonPhotoEditor`: render when `PersonDetails.canEditPhoto`.
 * - `useCropStep`: "pick → frame (lazy `ImageCropper`) → upload" glue.
 *
 * Import the cropper only through `useCropStep` (or a `lazy()` import of
 * `./ImageCropper`) so it stays out of the initial bundle.
 */
export { PERSON_PHOTO_REMOVED, PersonPhotoEditor, type PersonPhotoEditorProps } from "./PersonPhotoEditor";
export { type CropStep, useCropStep } from "./useCropStep";
export { usePersonPhotoUpload } from "./usePersonPhotoUpload";
