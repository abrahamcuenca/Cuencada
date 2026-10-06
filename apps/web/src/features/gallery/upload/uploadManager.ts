import type { CreateUploadResponse, MediaItem, MediaKind, MediaMimeType } from "@cuencada/types";
import type { AppStore } from "../../../app/store";
import { getApiErrorMessage } from "../../../shared/api/errors";
import { selectCurrentUser, selectSessionEpoch } from "../../auth/authSlice";
import { galleryApi } from "../api";
import { putToPresignedUrl, UploadTransferError } from "../lib/putToPresignedUrl";
import type { AcceptedFile } from "../lib/validateFile";

/** Uploads running at once (intent → PUT → confirm). Keeps phones on 4G responsive. */
export const MAX_CONCURRENT_UPLOADS = 2;
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

interface Job {
  entry: UploadEntry;
  file: File;
  mimeType: MediaMimeType;
  intent: CreateUploadResponse | null;
  putDone: boolean;
  controller: AbortController | null;
  canceled: boolean;
  confirmedAt: number | null;
}

const ACTIVE: ReadonlySet<UploadPhase> = new Set(["creating", "uploading", "confirming"]);
const IN_FLIGHT: ReadonlySet<UploadPhase> = new Set(["queued", "creating", "uploading", "confirming"]);

/**
 * Client-side upload queue for one store. Lives outside Redux because it
 * holds `File`s and XHR handles, which are not serializable (and `store.ts` is
 * frozen). It outlives route changes, so the list survives navigation, and it
 * resets itself on logout or user change [SEC].
 */
export class UploadManager {
  private jobs: Job[] = [];
  private snapshot: readonly UploadEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
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
        putDone: false,
        controller: null,
        canceled: false,
        confirmedAt: null
      });
    }
    this.emit();
    this.pump();
  }

  /** Requeues a failed upload. Reuses a still-valid intent and skips a PUT that already succeeded. */
  retry(id: string): void {
    const job = this.find(id);
    if (!job || job.entry.phase !== "failed") return;
    this.update(job, { phase: "queued", error: null, progress: job.putDone ? 1 : 0 });
    this.pump();
  }

  /** Aborts a queued or running upload and removes it from the list. The server's cleanup job drops abandoned intents. */
  cancel(id: string): void {
    const job = this.find(id);
    if (!job || (!IN_FLIGHT.has(job.entry.phase) && job.entry.phase !== "failed")) return;
    job.canceled = true;
    job.controller?.abort();
    this.remove(id);
    this.pump();
  }

  /** Removes a finished or failed row. */
  dismiss(id: string): void {
    const job = this.find(id);
    if (!job || IN_FLIGHT.has(job.entry.phase)) return;
    this.remove(id);
  }

  /** Removes every finished row (ready / in review / processing failed). */
  clearFinished(): void {
    this.jobs = this.jobs.filter((job) => !["ready", "review", "processing_failed"].includes(job.entry.phase));
    this.emit();
  }

  /**
   * Moves confirmed uploads forward from a fresh list response (the page polls
   * while anything is processing).
   *
   * @param year - Year of the list.
   * @param items - Items from every loaded page.
   * @param fetchedAt - When that response was fulfilled (ms).
   */
  syncFromList(year: number, items: readonly MediaItem[], fetchedAt: number): void {
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const job of this.jobs) {
      if (job.entry.year !== year || job.entry.phase !== "processing" || job.entry.mediaId === null) continue;
      if (job.confirmedAt === null || fetchedAt < job.confirmedAt) continue;
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

  /** Aborts everything and empties the list (logout, user change). */
  reset(): void {
    for (const job of this.jobs) {
      job.canceled = true;
      job.controller?.abort();
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

  private pump(): void {
    let active = this.jobs.filter((job) => ACTIVE.has(job.entry.phase)).length;
    for (const job of this.jobs) {
      if (active >= MAX_CONCURRENT_UPLOADS) break;
      if (job.entry.phase !== "queued") continue;
      active += 1;
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      await this.ensureIntent(job);
      if (!job.putDone) await this.put(job);
      await this.confirm(job);
    } catch (error) {
      // A refused signature (expired, or the bucket rejected it) is never reused: the retry asks for a new intent.
      if (error instanceof UploadTransferError && (error.failure === "expired" || error.failure === "rejected")) job.intent = null;
      if (!job.canceled) this.update(job, { phase: "failed", error: failureMessage(error) });
    } finally {
      job.controller = null;
      if (!job.canceled) this.pump();
    }
  }

  private async ensureIntent(job: Job): Promise<void> {
    const intent = job.intent;
    if (intent && Date.parse(intent.expiresAt) - Date.now() > INTENT_MARGIN_MS) return;
    job.intent = null;
    job.putDone = false;
    this.update(job, { phase: "creating", progress: 0 });
    const request = this.store.dispatch(
      galleryApi.endpoints.createUpload.initiate({
        year: job.entry.year,
        body: { fileName: job.entry.fileName, mimeType: job.mimeType, byteSize: job.file.size, caption: job.entry.caption }
      })
    );
    try {
      const created = await request.unwrap();
      job.intent = created;
      this.update(job, { mediaId: created.mediaId });
    } finally {
      request.reset();
    }
  }

  private async put(job: Job): Promise<void> {
    const intent = job.intent;
    if (!intent) throw new Error("Falta la intención de subida.");
    const controller = new AbortController();
    job.controller = controller;
    this.update(job, { phase: "uploading", progress: 0 });
    let lastPercent = -1;
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
  }

  private async confirm(job: Job): Promise<void> {
    const mediaId = job.entry.mediaId;
    if (mediaId === null) throw new Error("Falta el identificador de la subida.");
    this.update(job, { phase: "confirming", progress: 1 });
    const request = this.store.dispatch(galleryApi.endpoints.confirmUpload.initiate({ mediaId, year: job.entry.year }));
    try {
      const item = await request.unwrap();
      job.confirmedAt = Date.now();
      if (item.uploadStatus === "ready") this.update(job, { phase: item.moderationStatus === "approved" ? "ready" : "review" });
      else if (item.uploadStatus === "failed") this.update(job, { phase: "processing_failed", error: "No pudimos procesar este archivo." });
      else this.update(job, { phase: "processing" });
    } finally {
      request.reset();
    }
  }
}

/** User-safe message for any failure in the pipeline (never the presigned URL or a raw error message). */
function failureMessage(error: unknown): string {
  if (error instanceof UploadTransferError) return error.message;
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
