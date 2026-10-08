/**
 * Public surface of the gallery feature for other tracks.
 * T2 places `<GalleryPreview year={year} />` on `/cuencada/:year` (members only).
 * T5 (avatars) reuses the direct-upload helpers and the expired-URL refetch.
 * WP-4.3 (`ImageCropper`) reuses the resize worker for the square crop.
 */
export { GalleryPreview, type GalleryPreviewProps } from "./components/GalleryPreview";
export { type PutOptions, putToPresignedUrl, type TransferFailure, UploadTransferError } from "./lib/putToPresignedUrl";
export { AVATAR_RESIZE, CROP_OUTPUT_SIZE, ImageDecodeError, cropImageToSquare, decodeForPreview, shrinkImageIfNeeded } from "./lib/resizeImage";
export { type QuarterTurn, type SquareCropSpec, rotatedSize } from "./lib/cropCore";
export { isAllowedUploadUrl, uploadsConfigured } from "./lib/uploadOrigin";
export { useExpiredUrlRefetch } from "./lib/useExpiredUrlRefetch";
