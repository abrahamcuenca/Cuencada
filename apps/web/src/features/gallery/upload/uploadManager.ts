import type { CreateUploadResponse, MediaItem, MediaKind, MediaMimeType } from "@cuencada/types";
import type { AppStore } from "../../../app/store";
import { getApiErrorMessage } from "../../../shared/api/errors";
import { selectCurrentUser, selectSessionEpoch } from "../../auth/authSlice";
import { galleryApi, MEDIA_PAGE_SIZE } from "../api";
import { putToPresignedUrl, UploadTransferError } from "../lib/putToPresignedUrl";
import { GALLERY_RESIZE, ImageDecodeError, shrinkImageIfNeeded } from "../lib/resizeImage";
import { UploadsUnavailableError, uploadsConfigured } from "../lib/uploadOrigin";
import type { AcceptedFile } from "../lib/validateFile";

/** Uploads running at once (intent → PUT → confirm). Keeps phones on 4G responsive. */
export const MAX_CONCURRENT_UPLOADS = 2;
/** While anything is processing, the first page of its year is polled this often. */
export const PROCESSING_POLL_MS = 5000;
/** An intent closer than this to `expiresAt` is replaced instead of reused on retry. */
const INTENT_MARGIN_MS = 60_000;

/** Where one file is in the pipeline. */
export type UploadPhase =
  | "queued"
  | "creating"
  | "uploading"
  | "confirming"
  | "processing"
  | "ready"
  | "review"
  | "failed"
  | "processing_failed";

/** One row of the upload list (immutable snapshot, safe to render). */
export interface UploadEntry {
  id: string;
  year: number;
  fileName: string;
  byteSize: number;
  kind: MediaKind;
  caption: string | null;
  phase: UploadPhase;
  /** 0..1 while uploading. */
  progress: number;
  /** Spanish, user-safe (never a URL). */
  error: string | null;
  mediaId: string | null;
}

/** A file plus its optional caption, ready to queue. */
export interface UploadRequest {
  file: AcceptedFile;
  caption: string | null;
}

/** Anything in flight that cancel or logout must stop: an RTK request or the XHR. */
interface Abortable {
  abort: () => void;
}

interface Job {
  entry: UploadEntry;
  file: File;
  mimeType: MediaMimeType;
  intent: CreateUploadResponse | null;
  /** Very large photos were checked (and downscaled if needed) before the intent. */
  prepared: boolean;
  putDone: boolean;
  /** The current step's in-flight work (intent or confirm request, or the PUT's controller). */
  inFlight: Abortable | null;
  canceled: boolean;
  /** After a user cancel, delete the server-side `pending_upload` (not on logout: the session is gone). */
  deleteOnCancel: boolean;
  confirmedAt: number | null;
}

/** Phases in which the ✕ cancels. Not `confirming`: the bytes are in the bucket and the item may already be published. */
export const CANCELABLE_PHASES: ReadonlySet<UploadPhase> = new Set(["queued", "creating", "uploading", "failed"]);
const IN_FLIGHT: ReadonlySet<UploadPhase> = new Set(["queued", "creating", "uploading", "confirming"]);
const FINISHED: ReadonlySet<UploadPhase> = new Set(["ready", "review", "processing_failed"]);

/** Thrown inside the pipeline when the job was cancelled while a step was awaiting. */
function canceledError(): UploadTransferError {
  return new UploadTransferError("aborted", null);
}

/**
 * Client-side upload queue for one store. Lives outside Redux because it
 * holds `File`s and XHR handles, which are not serializable (and `store.ts` is
 * frozen). It outlives route changes, so the list survives navigation, and it
 * resets itself on logout or user change [SEC].
 *
 * Cancel semantics [SEC]: a cancelled job stops at the next step boundary
 * (its intent request, PUT or confirm is aborted, and every `await` is
 * followed by a cancel check), keeps its concurrency slot until that work has
 * settled, and then deletes its `pending_upload` on the server.
 */
export class UploadManager {
  private jobs: Job[] = [];
  /** Jobs whose pipeline is running, including cancelled ones that haven't settled yet. */
  private readonly running = new Set<Job>();
  private snapshot: readonly UploadEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private generation = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private unloadGuard: ((event: BeforeUnloadEvent) => void) | null = null;

  constructor(private readonly store: AppStore) {
    let epoch = selectSessionEpoch(store.getState());
    let userId = selectCurrentUser(store.getState())?.id ?? null;
    store.subscribe(() => {
      const state = store.getState();
      const nextEpoch = selectSessionEpoch(state);
      const nextUser = selectCurrentUser(state)?.id ?? null;
      if (nextEpoch !== epoch || nextUser !== userId) {
        epoch = nextEpoch;
        userId = nextUser;
        this.reset();
      }
    });
  }

  /** `useSyncExternalStore` subscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** `useSyncExternalStore` snapshot (stable until something changes). */
  getSnapshot = (): readonly UploadEntry[] => this.snapshot;

  /**
   * Queues files for a year and starts up to {@link MAX_CONCURRENT_UPLOADS}.
   *
   * @param year - Edition the files belong to.
   * @param requests - Validated files with optional captions.
   */
  enqueue(year: number, requests: readonly UploadRequest[]): void {
    for (const { file, caption } of requests) {
      this.sequence += 1;
      this.jobs.push({
        entry: {
          id: `upload-${this.sequence}`,
          year,
          fileName: file.fileName,
          byteSize: file.file.size,
          kind: file.kind,
          caption,
          phase: "queued",
          progress: 0,
          error: null,
          mediaId: null
        },
        file: file.file,
        mimeType: file.mimeType,
        intent: null,
        prepared: file.kind !== "image",
        putDone: false,
        inFlight: null,
        canceled: false,
        deleteOnCancel: true,
        confirmedAt: null
      });
    }
    this.emit();
    this.pump();
  }

  /** Requeues a failed upload. Reuses a still-valid intent and skips a PUT that already succeeded. */
  retry(id: string): void {
    const job = this.find(id);
    if (!job || job.entry.phase !== "failed" || this.running.has(job)) return;
    this.update(job, { phase: "queued", error: null, progress: job.putDone ? 1 : 0 });
    this.pump();
  }

  /**
   * Cancels a queued, preparing, uploading or failed upload: aborts its
   * in-flight request or XHR, removes the row, and deletes the server-side
   * `pending_upload` once the pipeline has stopped. Not available while
   * confirming (see {@link CANCELABLE_PHASES}).
   */
  cancel(id: string): void {
    const job = this.find(id);
    if (!job || !CANCELABLE_PHASES.has(job.entry.phase)) return;
    job.canceled = true;
    job.inFlight?.abort();
    this.remove(id);
    // A running job discards itself when its pipeline settles (and only then frees its slot).
    if (!this.running.has(job)) this.discard(job);
  }

  /** Removes a finished or failed row. */
  dismiss(id: string): void {
    const job = this.find(id);
    if (!job || IN_FLIGHT.has(job.entry.phase)) return;
    this.remove(id);
  }

  /** Removes every finished row (ready / in review / processing failed). */
  clearFinished(): void {
    this.jobs = this.jobs.filter((job) => !FINISHED.has(job.entry.phase));
    this.emit();
  }

  /**
   * Moves confirmed uploads forward from a fresh first page of their year.
   *
   * @param year - Year of the page.
   * @param items - The page's items (newest first, own non-ready items included).
   * @param requestedAt - When that request started (ms); older responses are ignored.
   */
  syncFromList(year: number, items: readonly MediaItem[], requestedAt: number): void {
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const job of this.jobs) {
      if (job.entry.year !== year || job.entry.phase !== "processing" || job.entry.mediaId === null) continue;
      if (job.confirmedAt === null || requestedAt < job.confirmedAt) continue;
      const item = byId.get(job.entry.mediaId);
      if (!item) {
        // Own items are listed until ready; a missing ready item is waiting for moderation (approval-first mode).
        this.update(job, { phase: "review" });
      } else if (item.uploadStatus === "ready") {
        this.update(job, { phase: item.moderationStatus === "approved" ? "ready" : "review" });
      } else if (item.uploadStatus === "failed") {
        this.update(job, { phase: "processing_failed", error: "No pudimos procesar este archivo. Prueba con otro formato." });
      }
    }
  }

  /** True while any file is queued or transferring (used for the `beforeunload` warning). */
  hasInFlight(): boolean {
    return this.jobs.some((job) => IN_FLIGHT.has(job.entry.phase));
  }

  /** Aborts everything and empties the list (logout, user change). No server calls: the session is gone. */
  reset(): void {
    this.generation += 1;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    for (const job of this.jobs) {
      job.canceled = true;
      job.deleteOnCancel = false;
      job.inFlight?.abort();
    }
    this.jobs = [];
    this.emit();
  }

  private find(id: string): Job | undefined {
    return this.jobs.find((job) => job.entry.id === id);
  }

  private remove(id: string): void {
    this.jobs = this.jobs.filter((job) => job.entry.id !== id);
    this.emit();
  }

  private update(job: Job, patch: Partial<UploadEntry>): void {
    if (job.canceled) return;
    job.entry = { ...job.entry, ...patch };
    this.emit();
  }

  private emit(): void {
    this.snapshot = this.jobs.map((job) => job.entry);
    this.syncUnloadGuard();
    for (const listener of this.listeners) listener();
  }

  private syncUnloadGuard(): void {
    const needed = this.hasInFlight();
    if (needed && !this.unloadGuard) {
      this.unloadGuard = (event: BeforeUnloadEvent): void => {
        event.preventDefault();
        // Legacy browsers only show the prompt when returnValue is set.
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", this.unloadGuard);
    } else if (!needed && this.unloadGuard) {
      window.removeEventListener("beforeunload", this.unloadGuard);
      this.unloadGuard = null;
    }
  }

  /** Starts queued jobs while slots are free. A job is marked started synchronously, so it can never start twice. */
  private pump(): void {
    for (const job of this.jobs) {
      if (this.running.size >= MAX_CONCURRENT_UPLOADS) break;
      if (job.entry.phase !== "queued" || job.canceled || this.running.has(job)) continue;
      this.running.add(job);
      this.update(job, { phase: "creating" });
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      await this.prepare(job);
      this.throwIfCanceled(job);
      await this.ensureIntent(job);
      this.throwIfCanceled(job);
      if (!job.putDone) {
        await this.put(job);
        this.throwIfCanceled(job);
      }
      await this.confirm(job);
    } catch (error) {
      if (job.canceled) return;
      // A refused signature (expired, or the bucket rejected it) is never reused: the retry asks for a new intent.
      if (error instanceof UploadTransferError && (error.failure === "expired" || error.failure === "rejected")) job.intent = null;
      this.update(job, { phase: "failed", error: failureMessage(error) });
    } finally {
      job.inFlight = null;
      this.running.delete(job);
      if (job.canceled) this.discard(job);
      this.pump();
      this.schedulePoll();
    }
  }

  private throwIfCanceled(job: Job): void {
    if (job.canceled) throw canceledError();
  }

  /**
   * Photos above ~40 MP are downscaled to ≤ 24 MP (JPEG) before the intent,
   * so the intent's type and size describe what is actually PUT. Smaller
   * photos and videos are untouched.
   */
  private async prepare(job: Job): Promise<void> {
    if (job.prepared) return;
    // No point decoding a photo this build can't upload (ensureIntent refuses it too).
    if (!uploadsConfigured()) throw new UploadsUnavailableError();
    const resized = await shrinkImageIfNeeded(job.file, GALLERY_RESIZE);
    if (resized !== null) {
      job.file = resized;
      job.mimeType = "image/jpeg";
      this.update(job, { byteSize: resized.size });
    }
    job.prepared = true;
  }

  private async ensureIntent(job: Job): Promise<void> {
    const intent = job.intent;
    if (intent && Date.parse(intent.expiresAt) - Date.now() > INTENT_MARGIN_MS) return;
    job.intent = null;
    job.putDone = false;
    this.update(job, { phase: "creating", progress: 0 });
    // [SEC/ops] Without a bucket origin every intent would be refused after the server already
    // created its row: don't ask for one at all.
    if (!uploadsConfigured()) throw new UploadsUnavailableError();
    const request = this.store.dispatch(
      galleryApi.endpoints.createUpload.initiate({
        year: job.entry.year,
        body: { fileName: job.file.name, mimeType: job.mimeType, byteSize: job.file.size, caption: job.entry.caption }
      })
    );
    job.inFlight = request;
    try {
      const created = await request.unwrap();
      // Kept even when cancelled meanwhile, so `discard` can delete the server row.
      job.intent = created;
      this.update(job, { mediaId: created.mediaId });
    } finally {
      job.inFlight = null;
      request.reset();
    }
  }

  private async put(job: Job): Promise<void> {
    const intent = job.intent;
    if (!intent) throw new Error("Falta la intención de subida.");
    this.throwIfCanceled(job);
    const controller = new AbortController();
    job.inFlight = controller;
    this.update(job, { phase: "uploading", progress: 0 });
    let lastPercent = -1;
    try {
      await putToPresignedUrl({
        url: intent.uploadUrl,
        headers: intent.headers,
        body: job.file,
        signal: controller.signal,
        onProgress: (fraction) => {
          // Re-render at most once per whole percent.
          const percent = Math.floor(fraction * 100);
          if (percent === lastPercent) return;
          lastPercent = percent;
          this.update(job, { progress: fraction });
        }
      });
      job.putDone = true;
    } finally {
      job.inFlight = null;
    }
  }

  private async confirm(job: Job): Promise<void> {
    const mediaId = job.intent?.mediaId;
    if (mediaId === undefined) throw new Error("Falta el identificador de la subida.");
    this.throwIfCanceled(job);
    this.update(job, { phase: "confirming", progress: 1 });
    const request = this.store.dispatch(galleryApi.endpoints.confirmUpload.initiate({ mediaId, year: job.entry.year }));
    job.inFlight = request;
    try {
      const item = await request.unwrap();
      this.throwIfCanceled(job);
      job.confirmedAt = Date.now();
      if (item.uploadStatus === "ready") this.update(job, { phase: item.moderationStatus === "approved" ? "ready" : "review" });
      else if (item.uploadStatus === "failed") this.update(job, { phase: "processing_failed", error: "No pudimos procesar este archivo." });
      else this.update(job, { phase: "processing" });
    } finally {
      job.inFlight = null;
      request.reset();
    }
  }

  /**
   * Deletes the server-side `pending_upload` of a cancelled job, best effort:
   * the server's abandoned-upload cleanup job removes it anyway if this fails.
   */
  private discard(job: Job): void {
    const mediaId = job.intent?.mediaId;
    job.intent = null;
    if (!job.deleteOnCancel || mediaId === undefined) return;
    const request = this.store.dispatch(galleryApi.endpoints.deleteMedia.initiate({ id: mediaId, year: job.entry.year }));
    request
      .unwrap()
      .catch(() => {
        // Best effort by design: no UI for a row the user already removed; the cleanup job is the backstop.
      })
      .finally(() => request.reset());
  }

  /** Polls the first page of every year with processing uploads, so rows resolve even after navigating away. */
  private schedulePoll(): void {
    if (this.pollTimer !== null || !this.jobs.some((job) => job.entry.phase === "processing")) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollProcessing();
    }, PROCESSING_POLL_MS);
  }

  private async pollProcessing(): Promise<void> {
    const generation = this.generation;
    const years = new Set(this.jobs.filter((job) => job.entry.phase === "processing").map((job) => job.entry.year));
    for (const year of years) {
      const requestedAt = Date.now();
      const request = this.store.dispatch(galleryApi.endpoints.mediaHead.initiate({ year, limit: MEDIA_PAGE_SIZE }, { subscribe: false, forceRefetch: true }));
      try {
        const page = await request.unwrap();
        if (generation !== this.generation) return;
        this.syncFromList(year, page.items, requestedAt);
      } catch {
        // A failed poll is retried on the next tick; rows stay "Procesando…".
      }
    }
    if (generation === this.generation) this.schedulePoll();
  }
}

/** User-safe message for any failure in the pipeline (never the presigned URL or a raw error message). */
function failureMessage(error: unknown): string {
  if (error instanceof UploadTransferError || error instanceof UploadsUnavailableError || error instanceof ImageDecodeError) return error.message;
  return getApiErrorMessage(error);
}

const managers = new WeakMap<AppStore, UploadManager>();

/**
 * The upload manager for a store, created on first use.
 *
 * @param store - The app store (one manager per store keeps tests isolated).
 * @returns The store's manager.
 */
export function getUploadManager(store: AppStore): UploadManager {
  let manager = managers.get(store);
  if (!manager) {
    manager = new UploadManager(store);
    managers.set(store, manager);
  }
  return manager;
}
