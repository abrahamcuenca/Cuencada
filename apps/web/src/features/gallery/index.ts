/**
 * Public surface of the gallery feature for other tracks.
 * T2 places `<GalleryPreview year={year} />` on `/cuencada/:year` (members only).
 * T5 (avatars) reuses the direct-upload helpers and the expired-URL refetch.
 */
export { GalleryPreview, type GalleryPreviewProps } from "./components/GalleryPreview";
export { type PutOptions, putToPresignedUrl, type TransferFailure, UploadTransferError } from "./lib/putToPresignedUrl";
export { isAllowedUploadUrl } from "./lib/uploadOrigin";
export { useExpiredUrlRefetch } from "./lib/useExpiredUrlRefetch";
