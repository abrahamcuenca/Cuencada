import { fileNameSchema, MEDIA_SIZE_LIMITS, type MediaKind, type MediaMimeType, MediaMimeType as MimeTypes, maxBytesForMime, mediaKindOfMime } from "@cuencada/types";

/** The `accept` attribute of the picker: exactly the contract allowlist (no `image/*`, so HEIC is not offered as-is). */
export const UPLOAD_ACCEPT = Object.values(MimeTypes).join(",");

const MB = 1024 * 1024;
/** Upload rules in plain Spanish, from the contract limits. */
export const UPLOAD_RULES_TEXT = `Fotos JPG, PNG o WebP de hasta ${MEDIA_SIZE_LIMITS.image / MB} MB y videos MP4 o MOV de hasta ${MEDIA_SIZE_LIMITS.video / MB} MB. iPhone convierte automáticamente a JPG al subir desde el navegador.`;
/**
 * Privacy note under the rules: the server strips photo EXIF, but some action
 * cameras and drones write GPS into extra video tracks (T4 follow-up L5).
 */
export const UPLOAD_LOCATION_NOTE = "Las cámaras de acción y drones pueden guardar ubicación en el video.";

const ALLOWED = new Set<string>(Object.values(MimeTypes));
const HEIC = /\.(heic|heif)$/i;

/** Fallback MIME types for files the OS reports without one (some Android file pickers). */
const EXTENSION_MIME: Record<string, MediaMimeType> = {
  jpg: MimeTypes.Jpeg,
  jpeg: MimeTypes.Jpeg,
  png: MimeTypes.Png,
  webp: MimeTypes.Webp,
  mp4: MimeTypes.Mp4,
  mov: MimeTypes.Quicktime
};

const MIME_EXTENSION: Record<MediaMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov"
};

/** A file that passed the client checks, with the values sent in the upload intent. */
export interface AcceptedFile {
  ok: true;
  file: File;
  fileName: string;
  mimeType: MediaMimeType;
  kind: MediaKind;
}

/** A file rejected before any request, with a Spanish reason. */
export interface RejectedFile {
  ok: false;
  file: File;
  fileName: string;
  reason: string;
}

/** Outcome of {@link validateUploadFile}. */
export type FileCheck = AcceptedFile | RejectedFile;

function isMediaMimeType(value: string): value is MediaMimeType {
  return ALLOWED.has(value);
}

function resolveMime(file: File): MediaMimeType | null {
  const declared = file.type.toLowerCase();
  if (isMediaMimeType(declared)) return declared;
  if (declared !== "") return null;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME[extension] ?? null;
}

/** A display name the contract accepts; odd names fall back to a generic one (the object key is server-side anyway). */
function safeFileName(file: File, mimeType: MediaMimeType | null): string {
  const parsed = fileNameSchema.safeParse(file.name.slice(0, 255));
  if (parsed.success) return parsed.data;
  return mimeType === null ? "archivo" : `archivo.${MIME_EXTENSION[mimeType]}`;
}

/**
 * Client-side check with the contract constants (allowlist + size limits).
 * The server re-checks everything; this only saves a round trip and explains
 * the problem in Spanish, per file.
 *
 * @param file - A file from the picker.
 * @returns The accepted values for the intent, or a Spanish rejection reason.
 */
export function validateUploadFile(file: File): FileCheck {
  const mimeType = resolveMime(file);
  const fileName = safeFileName(file, mimeType);

  if (mimeType === null) {
    const isHeic = HEIC.test(file.name) || /^image\/hei[cf]/i.test(file.type);
    return {
      ok: false,
      file,
      fileName,
      reason: isHeic
        ? "Las fotos HEIC no se pueden subir así. iPhone convierte automáticamente a JPG al subir desde el navegador: elígela desde Fotos (no desde Archivos)."
        : "Solo se pueden subir fotos (JPG, PNG o WebP) y videos (MP4 o MOV)."
    };
  }
  if (file.size === 0) return { ok: false, file, fileName, reason: "El archivo está vacío." };

  const kind = mediaKindOfMime(mimeType);
  const max = maxBytesForMime(mimeType);
  if (file.size > max) {
    const limit = Math.round(max / MB);
    return {
      ok: false,
      file,
      fileName,
      reason:
        kind === "video"
          ? `Este video pesa más de ${limit} MB. Recórtalo o súbelo desde una computadora.`
          : `Esta foto pesa más de ${limit} MB.`
    };
  }
  return { ok: true, file, fileName, mimeType, kind };
}

/**
 * Formats a byte count for the upload list ("3.4 MB").
 *
 * @param bytes - Size in bytes.
 * @returns A short Spanish-locale size.
 */
export function formatBytes(bytes: number): string {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / MB).toLocaleString("es-MX", { maximumFractionDigits: 1 })} MB`;
}
