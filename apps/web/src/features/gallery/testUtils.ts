/**
 * Test helpers for the gallery feature: media fixtures, an in-memory fake API
 * for MSW, and a controllable fake `XMLHttpRequest` for the direct bucket PUT.
 * Imported by tests only.
 */
import type { AdminMediaItem, CuencadaSummary, MediaItem, MediaReport } from "@cuencada/types";
import { HttpResponse, http, type HttpHandler } from "msw";
import { apiUrl, errorBody } from "../../../test/auth";

/** A valid v4 UUID for fixture `n`. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

/** A ready, approved photo. */
export function makeMedia(n: number, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: uuid(n),
    cuencadaId: uuid(9000),
    year: 2026,
    kind: "image",
    mimeType: "image/jpeg",
    thumbUrl: `https://bucket.example/thumb-${n}.webp?X-Amz-Signature=t${n}`,
    displayUrl: `https://bucket.example/display-${n}.webp?X-Amz-Signature=d${n}`,
    width: 1600,
    height: 1200,
    durationSeconds: null,
    caption: `Foto número ${n}`,
    uploaderName: "Rosa",
    isMine: false,
    uploadStatus: "ready",
    moderationStatus: "approved",
    createdAt: new Date(Date.UTC(2026, 8, 14, 18, 0, 0) - n * 60_000).toISOString(),
    ...overrides
  };
}

/** Admin view of {@link makeMedia}. */
export function makeAdminMedia(n: number, overrides: Partial<AdminMediaItem> = {}): AdminMediaItem {
  return {
    ...makeMedia(n),
    uploaderUserId: uuid(500),
    fileName: `IMG_${n}.jpg`,
    byteSize: 2_000_000,
    reportCount: 0,
    moderatedAt: null,
    moderatedByName: null,
    moderationNote: null,
    ...overrides
  };
}

/** A published edition summary. */
export function makeEdition(year: number, startsAt = `${year}-09-13T12:00:00.000Z`): CuencadaSummary {
  return {
    id: uuid(9000 + year),
    year,
    slug: String(year),
    title: `Cuencada ${year}`,
    status: "past",
    startsAt,
    endsAt: startsAt,
    city: "Mérida",
    state: "Yucatán",
    heroImageUrl: null,
    themeColor: "#0b5e55"
  };
}

/** The signed upload URL the fake API hands out (tests assert it never leaks). */
export const SIGNED_PUT_URL = "https://bucket.example/uploads/obj-1?X-Amz-Signature=supersecret";

/** Mutable state behind {@link galleryHandlers}. */
export interface FakeGalleryDb {
  editions: CuencadaSummary[];
  media: MediaItem[];
  admin: AdminMediaItem[];
  reports: Record<string, MediaReport[]>;
  /** Every request as `METHOD path?query`, for assertions. */
  log: string[];
  /** Status to return for the next confirm (`processing` or `ready`). */
  confirmStatus: MediaItem["uploadStatus"];
  nextId: number;
  /** Request bodies by `METHOD path`. */
  bodies: Record<string, unknown>;
}

/** A fresh fake database. */
export function makeDb(overrides: Partial<FakeGalleryDb> = {}): FakeGalleryDb {
  return {
    editions: [makeEdition(2026), makeEdition(2025)],
    media: [],
    admin: [],
    reports: {},
    log: [],
    confirmStatus: "processing",
    nextId: 1000,
    bodies: {},
    ...overrides
  };
}

function paginate<TItem>(items: readonly TItem[], url: URL): { items: TItem[]; nextCursor: string | null } {
  const limit = Number(url.searchParams.get("limit") ?? "20");
  const start = Number(url.searchParams.get("cursor") ?? "0");
  const page = items.slice(start, start + limit);
  const next = start + limit;
  return { items: page, nextCursor: next < items.length ? String(next) : null };
}

function record(db: FakeGalleryDb, request: Request): URL {
  const url = new URL(request.url);
  db.log.push(`${request.method} ${url.pathname.replace(/^\/api/, "")}${url.search}`);
  return url;
}

/**
 * MSW handlers backed by `db`.
 *
 * @param db - Mutable fake state.
 * @returns Handlers for every gallery endpoint.
 */
export function galleryHandlers(db: FakeGalleryDb): HttpHandler[] {
  return [
    http.get(apiUrl("/cuencadas"), ({ request }) => {
      record(db, request);
      return HttpResponse.json(db.editions);
    }),
    http.get(apiUrl("/cuencadas/:year/media"), ({ request, params }) => {
      const url = record(db, request);
      const year = Number(params.year);
      return HttpResponse.json(paginate(db.media.filter((m) => m.year === year), url));
    }),
    http.post(apiUrl("/cuencadas/:year/media/uploads"), async ({ request }) => {
      record(db, request);
      // Test fixture: the uploader sends `CreateUploadRequest` JSON.
      const body = (await request.json()) as { fileName: string; mimeType: string; byteSize: number; caption: string | null };
      db.bodies[`POST uploads ${body.fileName}`] = body;
      db.nextId += 1;
      return HttpResponse.json(
        {
          mediaId: uuid(db.nextId),
          uploadUrl: SIGNED_PUT_URL,
          headers: { "Content-Type": body.mimeType, "Content-Length": String(body.byteSize) },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString()
        },
        { status: 201 }
      );
    }),
    http.post(apiUrl("/media/:id/confirm"), ({ request, params }) => {
      record(db, request);
      const id = String(params.id);
      const item = makeMedia(Number(id.slice(-6)), {
        id,
        isMine: true,
        uploadStatus: db.confirmStatus,
        thumbUrl: db.confirmStatus === "ready" ? "https://bucket.example/new.webp" : null,
        displayUrl: db.confirmStatus === "ready" ? "https://bucket.example/new-d.webp" : null,
        createdAt: new Date().toISOString()
      });
      db.media = [item, ...db.media];
      return HttpResponse.json(item);
    }),
    http.patch(apiUrl("/media/:id"), async ({ request, params }) => {
      record(db, request);
      // Test fixture: `UpdateMediaRequest` JSON.
      const body = (await request.json()) as { caption: string | null };
      db.bodies[`PATCH ${String(params.id)}`] = body;
      const item = db.media.find((m) => m.id === params.id);
      if (!item) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      item.caption = body.caption;
      return HttpResponse.json(item);
    }),
    http.delete(apiUrl("/media/:id"), ({ request, params }) => {
      record(db, request);
      db.media = db.media.filter((m) => m.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(apiUrl("/media/:id/report"), async ({ request, params }) => {
      record(db, request);
      db.bodies[`REPORT ${String(params.id)}`] = await request.json();
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(apiUrl("/admin/media"), ({ request }) => {
      const url = record(db, request);
      const status = url.searchParams.get("moderationStatus");
      const reported = url.searchParams.get("reported") === "true";
      const list = db.admin.filter((m) => (status === null || m.moderationStatus === status) && (!reported || m.reportCount > 0));
      return HttpResponse.json(paginate(list, url));
    }),
    http.get(apiUrl("/admin/media/:id/reports"), ({ request, params }) => {
      record(db, request);
      return HttpResponse.json(db.reports[String(params.id)] ?? []);
    }),
    http.post(apiUrl("/admin/media/:id/moderate"), async ({ request, params }) => {
      record(db, request);
      // Test fixture: `ModerateMediaRequest` JSON.
      const body = (await request.json()) as { action: "approve" | "hide" | "delete" };
      const item = db.admin.find((m) => m.id === params.id);
      if (!item) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      if (body.action === "delete") db.admin = db.admin.filter((m) => m.id !== item.id);
      else item.moderationStatus = body.action === "approve" ? "approved" : "hidden";
      return HttpResponse.json(item);
    })
  ];
}

/** Controllable stand-in for `XMLHttpRequest` (the bucket PUT). Install with `vi.stubGlobal`. */
export class FakeXhr {
  static instances: FakeXhr[] = [];

  method = "";
  url = "";
  readonly headers: Record<string, string> = {};
  withCredentials = false;
  status = 0;
  body: unknown = null;
  aborted = false;
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: unknown): void {
    this.body = body;
    FakeXhr.instances.push(this);
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  /** Simulates upload progress. */
  progress(loaded: number, total: number): void {
    this.upload.onprogress?.(new ProgressEvent("progress", { lengthComputable: true, loaded, total }));
  }

  /** Completes the request with `status`. */
  respond(status: number): void {
    this.status = status;
    this.onload?.();
  }

  /** Simulates a network failure. */
  fail(): void {
    this.onerror?.();
  }
}
