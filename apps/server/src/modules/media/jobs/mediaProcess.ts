/**
 * Media processing job (runs on the serial `app.jobs` queue).
 *
 * Images: download the original → sharp auto-orient → strip all metadata
 * (sharp writes none unless asked; EXIF/GPS/XMP/ICC comments are dropped) →
 * 400px and 1600px WebP → upload with immutable private caching → `ready`.
 * Videos: no transcoding; the original is the display copy, with the duration
 * read from `mvhd` when it is cheaply available.
 *
 * State lives in the DB (`upload_status`), so a crash or shutdown leaves the
 * row in `processing` and {@link requeueStuckProcessing} picks it up on the
 * next start. Logs carry the media id and a short code only: never object
 * keys, URLs, file names or user data.
 */
import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import sharp, { type Metadata, type Sharp } from "sharp";
import type { Database } from "../../../db/client.js";
import { cuencadas, mediaItems } from "../../../db/schema/index.js";
import type { Clock } from "../../../lib/clock.js";
import type { JobQueue } from "../../../lib/jobs.js";
import type { StorageService } from "../../../lib/storage/types.js";
import {
  DERIVATIVE_CACHE_CONTROL,
  DISPLAY_WIDTH,
  MAX_INPUT_PIXELS,
  MEDIA_PROCESS_JOB,
  THUMB_WIDTH,
  VIDEO_PROBE_BYTES
} from "../constants.js";
import { mediaKeys, readMp4DurationSeconds } from "../files.js";
import type { MediaRow } from "../service.js";

/** What the job needs from the app. */
export interface MediaJobDeps {
  db: Database;
  storage: StorageService;
  clock: Clock;
  log: FastifyBaseLogger;
  jobs: JobQueue;
}

/** Short, log-safe failure codes stored in `processing_error`. */
export const ProcessingErrorCode = {
  StorageRead: "storage_read_failed",
  StorageWrite: "storage_write_failed",
  SizeMismatch: "size_mismatch",
  PixelLimit: "pixel_limit_exceeded",
  FormatMismatch: "format_mismatch",
  DecodeFailed: "decode_failed",
  Unknown: "processing_failed"
} as const;
export type ProcessingErrorCode = (typeof ProcessingErrorCode)[keyof typeof ProcessingErrorCode];

/** A classified processing failure. `cause` is never logged (it may contain a key). */
export class MediaProcessingError extends Error {
  readonly code: ProcessingErrorCode;

  constructor(code: ProcessingErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "MediaProcessingError";
    this.code = code;
  }
}

/** Columns the job sets on success. */
interface ProcessedFields {
  thumbKey: string | null;
  displayKey: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/** sharp format names per allowed image MIME type. */
const SHARP_FORMAT: Partial<Record<MediaRow["mimeType"], string>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp"
};

async function stage<TResult>(code: ProcessingErrorCode, run: () => Promise<TResult>): Promise<TResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MediaProcessingError) throw error;
    throw new MediaProcessingError(code, { cause: error });
  }
}

function decodeErrorCode(error: unknown): ProcessingErrorCode {
  const message = error instanceof Error ? error.message : "";
  return /pixel limit/i.test(message) ? ProcessingErrorCode.PixelLimit : ProcessingErrorCode.DecodeFailed;
}

function sharpInput(input: Uint8Array): Sharp {
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
}

/** WebP derivative: auto-orient, bound the size, write no metadata at all. */
async function derivative(input: Uint8Array, width: number): Promise<Buffer> {
  return sharpInput(input)
    .rotate()
    .resize({ width, height: width * 4, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

async function processImage(
  deps: MediaJobDeps,
  row: MediaRow,
  year: number,
  signal: AbortSignal,
  created: string[]
): Promise<ProcessedFields> {
  const expectedFormat = SHARP_FORMAT[row.mimeType];
  if (expectedFormat === undefined) throw new MediaProcessingError(ProcessingErrorCode.FormatMismatch);
  const input = await stage(ProcessingErrorCode.StorageRead, () => deps.storage.getRange(row.objectKey, 0, row.byteSize - 1));
  if (input.byteLength !== row.byteSize) throw new MediaProcessingError(ProcessingErrorCode.SizeMismatch);
  signal.throwIfAborted();

  let metadata: Metadata;
  try {
    metadata = await sharpInput(input).metadata();
  } catch (error) {
    throw new MediaProcessingError(decodeErrorCode(error), { cause: error });
  }
  if (metadata.format !== expectedFormat) throw new MediaProcessingError(ProcessingErrorCode.FormatMismatch);
  const oriented = metadata.autoOrient;

  let thumb: Buffer;
  let display: Buffer;
  try {
    thumb = await derivative(input, THUMB_WIDTH);
    signal.throwIfAborted();
    display = await derivative(input, DISPLAY_WIDTH);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new MediaProcessingError(decodeErrorCode(error), { cause: error });
  }
  signal.throwIfAborted();

  const keys = mediaKeys(year, row.id, row.mimeType);
  await stage(ProcessingErrorCode.StorageWrite, async () => {
    created.push(keys.thumb);
    await deps.storage.put({ key: keys.thumb, body: thumb, contentType: "image/webp", cacheControl: DERIVATIVE_CACHE_CONTROL });
    created.push(keys.display);
    await deps.storage.put({
      key: keys.display,
      body: display,
      contentType: "image/webp",
      cacheControl: DERIVATIVE_CACHE_CONTROL
    });
  });
  return {
    thumbKey: keys.thumb,
    displayKey: keys.display,
    width: oriented.width,
    height: oriented.height,
    durationSeconds: null
  };
}

async function processVideo(deps: MediaJobDeps, row: MediaRow): Promise<ProcessedFields> {
  const end = Math.min(row.byteSize, VIDEO_PROBE_BYTES) - 1;
  const probe = await stage(ProcessingErrorCode.StorageRead, () => deps.storage.getRange(row.objectKey, 0, end));
  return {
    thumbKey: null,
    displayKey: row.objectKey,
    width: null,
    height: null,
    durationSeconds: readMp4DurationSeconds(probe)
  };
}

async function deleteQuietly(deps: MediaJobDeps, mediaId: string, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await deps.storage.delete(key);
    } catch (error) {
      deps.log.warn({ mediaId, errorName: error instanceof Error ? error.name : "unknown" }, "media object delete failed");
    }
  }
}

/**
 * Process one media item that is in `processing`. Never throws: failures
 * mark the row `failed` with a short code. An abort (shutdown) leaves the row
 * in `processing` for the next start.
 *
 * @param deps - DB, storage, clock and logger.
 * @param mediaId - Item to process.
 * @param signal - Fires when the queue closes.
 */
export async function processMediaItem(deps: MediaJobDeps, mediaId: string, signal: AbortSignal): Promise<void> {
  const [found] = await deps.db
    .select({ item: mediaItems, year: cuencadas.year })
    .from(mediaItems)
    .innerJoin(cuencadas, eq(cuencadas.id, mediaItems.cuencadaId))
    .where(and(eq(mediaItems.id, mediaId), eq(mediaItems.uploadStatus, "processing"), isNull(mediaItems.deletedAt)))
    .limit(1);
  if (found === undefined) return;
  const { item, year } = found;
  const created: string[] = [];
  const stillProcessing = and(
    eq(mediaItems.id, mediaId),
    eq(mediaItems.uploadStatus, "processing"),
    isNull(mediaItems.deletedAt)
  );

  try {
    const fields =
      item.kind === "image" ? await processImage(deps, item, year, signal, created) : await processVideo(deps, item);
    signal.throwIfAborted();
    const updated = await deps.db
      .update(mediaItems)
      .set({ ...fields, uploadStatus: "ready", processedAt: deps.clock.now(), processingError: null })
      .where(stillProcessing)
      .returning({ id: mediaItems.id });
    if (updated.length === 0) {
      // Deleted (or moderated away) while we worked: do not leave derivatives behind.
      await deleteQuietly(deps, mediaId, created);
      deps.log.info({ mediaId }, "media removed during processing; derivatives discarded");
      return;
    }
    deps.log.info({ mediaId, kind: item.kind }, "media processed");
  } catch (error) {
    if (signal.aborted) {
      deps.log.info({ mediaId }, "media processing interrupted; will resume on next start");
      return;
    }
    const code = error instanceof MediaProcessingError ? error.code : ProcessingErrorCode.Unknown;
    deps.log.warn({ mediaId, code }, "media processing failed");
    await deleteQuietly(deps, mediaId, created);
    await deps.db
      .update(mediaItems)
      .set({ uploadStatus: "failed", processingError: code })
      .where(stillProcessing);
  }
}

/**
 * Queue processing for one item.
 *
 * @returns `false` when the queue is closed (the row stays `processing` and is re-queued on start).
 */
export function enqueueMediaProcessing(deps: MediaJobDeps, mediaId: string): boolean {
  return deps.jobs.enqueue(MEDIA_PROCESS_JOB, (signal) => processMediaItem(deps, mediaId, signal));
}

/**
 * Re-queue every live item left in `processing` (crash, deploy, shutdown).
 *
 * @returns How many items were queued.
 */
export async function requeueStuckProcessing(deps: MediaJobDeps): Promise<number> {
  const rows = await deps.db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(and(eq(mediaItems.uploadStatus, "processing"), isNull(mediaItems.deletedAt)))
    .orderBy(mediaItems.createdAt);
  for (const row of rows) enqueueMediaProcessing(deps, row.id);
  if (rows.length > 0) deps.log.info({ count: rows.length }, "re-queued media stuck in processing");
  return rows.length;
}
