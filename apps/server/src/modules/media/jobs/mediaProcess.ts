/**
 * Media processing job (runs on the serial `app.jobs` queue).
 *
 * Both kinds read the original back and **re-check its magic bytes and size**
 * (the presigned PUT stays valid for minutes after confirm, so the bytes may
 * have been swapped), write a sanitized copy under a key the client never
 * had a URL for, serve only that copy, and then delete the original (it
 * still holds GPS/camera metadata).
 *
 * - Images: sharp auto-orient → strip all metadata (sharp writes none unless
 *   asked) → 1600px WebP display copy; the 400px thumbnail is derived from
 *   that copy, so the original is decoded once.
 * - Videos (MP4/QuickTime): no transcoding and no ffmpeg. Location and
 *   identifying boxes (`udta`, `meta`, `uuid`/XMP) are overwritten in place
 *   with same-size `free` boxes (`neutralizeVideoMetadata`), so chunk offsets
 *   stay valid; the result goes to `display/{id}.mp4|.mov`.
 *
 * State lives in the DB. An item still in `processing` at the next start was
 * interrupted (shutdown, or a native crash/OOM): {@link failInterruptedProcessing}
 * marks it `failed` (`interrupted`) instead of re-running it, so a poison
 * input cannot crash-loop the server. Logs carry the media id and a short
 * code only: never object keys, URLs, file names or user data.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
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
  THUMB_WIDTH
} from "../constants.js";
import { mediaKeys, neutralizeVideoMetadata, readMp4DurationSeconds, signatureMatches } from "../files.js";
import { deleteObjectsQuietly } from "../objects.js";
import { allObjectKeys, type MediaRow } from "../service.js";

// One libvips thread and no operation cache: uploads are serial, and the
// libuv pool is shared with argon2 (logins must stay fast during a burst).
sharp.concurrency(1);
sharp.cache(false);

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
  SignatureMismatch: "signature_mismatch",
  PixelLimit: "pixel_limit_exceeded",
  FormatMismatch: "format_mismatch",
  DecodeFailed: "decode_failed",
  VideoStructure: "video_structure_invalid",
  Interrupted: "interrupted",
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

/** Resize to a WebP that fits `width` × 4·`width`; no metadata is written. */
function toWebp(pipeline: Sharp, width: number): Promise<Buffer> {
  return pipeline
    .resize({ width, height: width * 4, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

/**
 * Read the whole original and re-validate it: exact size and an allowed
 * signature for the declared type. Closes the post-confirm swap window.
 */
async function readValidatedOriginal(deps: MediaJobDeps, row: MediaRow): Promise<Uint8Array> {
  if (row.byteSize < 1) throw new MediaProcessingError(ProcessingErrorCode.SizeMismatch);
  const input = await stage(ProcessingErrorCode.StorageRead, () => deps.storage.getRange(row.objectKey, 0, row.byteSize - 1));
  if (input.byteLength !== row.byteSize) throw new MediaProcessingError(ProcessingErrorCode.SizeMismatch);
  const head = await stage(ProcessingErrorCode.StorageRead, () => deps.storage.head(row.objectKey));
  if (head === null || head.contentLength !== row.byteSize) throw new MediaProcessingError(ProcessingErrorCode.SizeMismatch);
  if (!signatureMatches(row.mimeType, input)) throw new MediaProcessingError(ProcessingErrorCode.SignatureMismatch);
  return input;
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
  const input = await readValidatedOriginal(deps, row);
  signal.throwIfAborted();

  let metadata: Metadata;
  try {
    metadata = await sharpInput(input).metadata();
  } catch (error) {
    throw new MediaProcessingError(decodeErrorCode(error), { cause: error });
  }
  if (metadata.format !== expectedFormat) throw new MediaProcessingError(ProcessingErrorCode.FormatMismatch);

  let display: Buffer;
  let thumb: Buffer;
  try {
    // The only full decode of the original; the thumbnail comes from the display copy.
    display = await toWebp(sharpInput(input).rotate(), DISPLAY_WIDTH);
    signal.throwIfAborted();
    thumb = await toWebp(sharp(display, { failOn: "error" }), THUMB_WIDTH);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new MediaProcessingError(decodeErrorCode(error), { cause: error });
  }
  signal.throwIfAborted();

  const keys = mediaKeys(year, row.id, row.mimeType);
  await stage(ProcessingErrorCode.StorageWrite, async () => {
    created.push(keys.display);
    await deps.storage.put({ key: keys.display, body: display, contentType: "image/webp", cacheControl: DERIVATIVE_CACHE_CONTROL });
    created.push(keys.thumb);
    await deps.storage.put({ key: keys.thumb, body: thumb, contentType: "image/webp", cacheControl: DERIVATIVE_CACHE_CONTROL });
  });
  return {
    thumbKey: keys.thumb,
    displayKey: keys.display,
    width: metadata.autoOrient.width,
    height: metadata.autoOrient.height,
    durationSeconds: null
  };
}

/**
 * Videos are buffered whole (≤ 300 MB, one at a time on the serial queue):
 * `StorageService` has no streaming read/write yet (WP Request 1).
 */
async function processVideo(
  deps: MediaJobDeps,
  row: MediaRow,
  year: number,
  signal: AbortSignal,
  created: string[]
): Promise<ProcessedFields> {
  const input = await readValidatedOriginal(deps, row);
  signal.throwIfAborted();
  try {
    neutralizeVideoMetadata(input);
  } catch (error) {
    throw new MediaProcessingError(ProcessingErrorCode.VideoStructure, { cause: error });
  }
  const durationSeconds = readMp4DurationSeconds(input);
  signal.throwIfAborted();

  const keys = mediaKeys(year, row.id, row.mimeType);
  await stage(ProcessingErrorCode.StorageWrite, async () => {
    created.push(keys.display);
    await deps.storage.put({ key: keys.display, body: input, contentType: row.mimeType, cacheControl: DERIVATIVE_CACHE_CONTROL });
  });
  return { thumbKey: null, displayKey: keys.display, width: null, height: null, durationSeconds };
}

/**
 * Process one media item that is in `processing`. Never throws: failures
 * mark the row `failed` with a short code and delete the original and any
 * partial output. An abort (shutdown) leaves the row in `processing`; the
 * next start marks it `interrupted`.
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
  // Logged before decoding, so a native crash can be traced to an item.
  deps.log.info({ mediaId, kind: item.kind }, "media processing started");

  try {
    const fields =
      item.kind === "image"
        ? await processImage(deps, item, year, signal, created)
        : await processVideo(deps, item, year, signal, created);
    signal.throwIfAborted();
    const updated = await deps.db
      .update(mediaItems)
      .set({ ...fields, uploadStatus: "ready", processedAt: deps.clock.now(), processingError: null })
      .where(stillProcessing)
      .returning({ id: mediaItems.id });
    if (updated.length === 0) {
      // Deleted while we worked: leave nothing behind.
      await deleteObjectsQuietly(deps, mediaId, [...created, item.objectKey]);
      deps.log.info({ mediaId }, "media removed during processing; outputs discarded");
      return;
    }
    // Only the sanitized copies are served; the original keeps GPS/camera metadata.
    await deleteObjectsQuietly(deps, mediaId, [item.objectKey]);
    deps.log.info({ mediaId, kind: item.kind }, "media processed");
  } catch (error) {
    if (signal.aborted) {
      deps.log.info({ mediaId }, "media processing interrupted by shutdown");
      return;
    }
    const code = error instanceof MediaProcessingError ? error.code : ProcessingErrorCode.Unknown;
    deps.log.warn({ mediaId, code }, "media processing failed");
    await deps.db.update(mediaItems).set({ uploadStatus: "failed", processingError: code }).where(stillProcessing);
    await deleteObjectsQuietly(deps, mediaId, [...new Set([...created, ...allObjectKeys(item, year)])]);
  }
}

/**
 * Queue processing for one item.
 *
 * @returns `false` when the queue is closed (the row stays `processing` and is failed as `interrupted` on the next start).
 */
export function enqueueMediaProcessing(deps: MediaJobDeps, mediaId: string): boolean {
  return deps.jobs.enqueue(MEDIA_PROCESS_JOB, (signal) => processMediaItem(deps, mediaId, signal));
}

/**
 * On start: every live item left in `processing` was interrupted (shutdown,
 * crash or OOM). Mark it `failed` (`interrupted`) and delete its objects;
 * never re-run it, so a poison input cannot crash-loop the server. The
 * uploader sees a failed tile and uploads again.
 *
 * @returns How many items were failed.
 */
export async function failInterruptedProcessing(deps: Pick<MediaJobDeps, "db" | "storage" | "log">): Promise<number> {
  const rows = await deps.db
    .select({ item: mediaItems, year: cuencadas.year })
    .from(mediaItems)
    .innerJoin(cuencadas, eq(cuencadas.id, mediaItems.cuencadaId))
    .where(and(eq(mediaItems.uploadStatus, "processing"), isNull(mediaItems.deletedAt)));
  let failed = 0;
  for (const { item, year } of rows) {
    const updated = await deps.db
      .update(mediaItems)
      .set({ uploadStatus: "failed", processingError: ProcessingErrorCode.Interrupted })
      .where(and(eq(mediaItems.id, item.id), eq(mediaItems.uploadStatus, "processing"), isNull(mediaItems.deletedAt)))
      .returning({ id: mediaItems.id });
    if (updated.length === 0) continue;
    failed += 1;
    deps.log.warn({ mediaId: item.id, code: ProcessingErrorCode.Interrupted }, "media processing interrupted; marked failed");
    await deleteObjectsQuietly(deps, item.id, allObjectKeys(item, year));
  }
  return failed;
}
