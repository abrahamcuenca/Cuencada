/**
 * Test helpers for the gallery feature: media fixtures, an in-memory fake API
 * for MSW, and a controllable fake `XMLHttpRequest` for the direct bucket PUT.
 * Imported by tests only.
 */
import type { AdminMediaItem, AdminReportedComment, CuencadaSummary, MediaComment, MediaItem, MediaLiker, MediaReport, MediaTag, TagCandidate } from "@cuencada/types";
import { HttpResponse, http, type HttpHandler } from "msw";
import { apiUrl, errorBody } from "../../../test/auth";

/** A valid v4 UUID for fixture `n`. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

/** A ready, approved photo. */
export function makeMedia(n: number, overrides: Partial<MediaItem> = {}): MediaItem {
  // Like the server: the uploader may manage their item (admins get the flags via overrides).
  const ownsItem = overrides.isMine ?? false;
  return {
    canEdit: ownsItem,
    canDelete: ownsItem,
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
    // Consistent with the dates, like the server: the gallery's default year trusts `past`.
    status: Date.parse(startsAt) > Date.now() ? "upcoming" : "past",
    startsAt,
    endsAt: startsAt,
    timezone: "America/Merida",
    city: "Mérida",
    state: "Yucatán",
    heroImageUrl: null,
    themeColor: "#0b5e55",
    hasMedia: true
  };
}

/** The bucket origin tests configure as `env.mediaUploadOrigin`. */
export const BUCKET_ORIGIN = "https://bucket.example";

/** The signed upload URL the fake API hands out (tests assert it never leaks). */
export const SIGNED_PUT_URL = `${BUCKET_ORIGIN}/uploads/obj-1?X-Amz-Signature=supersecret`;

/** A promise the test resolves by hand, to hold a fake response in flight. */
export interface Gate {
  promise: Promise<void>;
  release: () => void;
}

/** Creates a {@link Gate}. */
export function makeGate(): Gate {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

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
  /** `uploadUrl` returned by the intent. */
  uploadUrl: string;
  /** When set, intent responses wait for it. */
  holdUploads: Promise<void> | null;
  /** When set, confirm responses wait for it. */
  holdConfirm: Promise<void> | null;
  /** WP-6.2: social state per media id (see {@link socialOf}). */
  social: Record<string, FakeSocial>;
  /** WP-6.2: items reachable only by id (`/detail`), e.g. a deep link to a photo not in the list. */
  byIdOnly: MediaItem[];
  /** WP-6.2: the admin comment-report queue. */
  commentReports: AdminReportedComment[];
  /** WP-6.2: "Fotos de {persona}" by person id. */
  personPhotos: Record<string, MediaItem[]>;
}

/** WP-6.2: what the fake server knows about one item's social side. */
export interface FakeSocial {
  tags: MediaTag[];
  likeCount: number;
  likedByMe: boolean;
  likers: MediaLiker[];
  comments: MediaComment[];
  canTag: boolean;
  /** People the tag picker may return (filtered by `q`). */
  candidates: TagCandidate[];
  /** Status of the next created tag as the server answers it (the tagger sees `approved`). */
  nextTagStatus: MediaTag["status"];
  /** Comment ids already reported by the caller (→ 409). */
  reported: string[];
}

/** The social state of `mediaId`, created empty on first use. */
export function socialOf(db: FakeGalleryDb, mediaId: string): FakeSocial {
  let state = db.social[mediaId];
  if (state === undefined) {
    state = { tags: [], likeCount: 0, likedByMe: false, likers: [], comments: [], canTag: true, candidates: [], nextTagStatus: "approved", reported: [] };
    db.social[mediaId] = state;
  }
  return state;
}

/** A tag fixture. */
export function makeTag(n: number, overrides: Partial<MediaTag> = {}): MediaTag {
  return {
    id: uuid(7000 + n),
    person: { id: uuid(8000 + n), name: `Persona ${n}`, avatarUrl: null },
    status: "approved",
    isMe: false,
    canRemove: false,
    canApprove: false,
    ...overrides
  };
}

/** A live comment fixture. */
export function makeComment(n: number, mediaId: string, overrides: Partial<MediaComment> = {}): MediaComment {
  return {
    id: uuid(6000 + n),
    mediaId,
    author: { name: `Autor ${n}`, avatarUrl: null, isMe: false },
    body: `Comentario ${n}`,
    deleted: false,
    createdAt: new Date(Date.UTC(2026, 8, 14, 19, n, 0)).toISOString(),
    canDelete: false,
    canModerate: false,
    ...overrides
  };
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
    uploadUrl: SIGNED_PUT_URL,
    holdUploads: null,
    holdConfirm: null,
    social: {},
    byIdOnly: [],
    commentReports: [],
    personPhotos: {},
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
      // Like T2-BE: `hasMedia` is true when the edition has a visible item.
      return HttpResponse.json(
        db.editions.map((edition) => ({
          ...edition,
          hasMedia: db.media.some((m) => m.year === edition.year && m.uploadStatus === "ready" && m.moderationStatus === "approved")
        }))
      );
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
      const mediaId = uuid(db.nextId);
      if (db.holdUploads) await db.holdUploads;
      return HttpResponse.json(
        {
          mediaId,
          uploadUrl: db.uploadUrl,
          headers: { "Content-Type": body.mimeType },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString()
        },
        { status: 201 }
      );
    }),
    http.post(apiUrl("/media/:id/confirm"), async ({ request, params }) => {
      record(db, request);
      if (db.holdConfirm) await db.holdConfirm;
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
    }),
    ...socialHandlers(db)
  ];
}

/** WP-6.2 social endpoints over `db.social` (detail, tags, likes, comments, reports, person photos). */
function socialHandlers(db: FakeGalleryDb): HttpHandler[] {
  const findItem = (id: string): MediaItem | undefined => db.media.find((m) => m.id === id) ?? db.byIdOnly.find((m) => m.id === id);
  const notFound = (): Response => HttpResponse.json(errorBody("NOT_FOUND", "No encontramos esa foto o video."), { status: 404 });
  const liveCount = (state: FakeSocial): number => state.comments.filter((c) => !c.deleted).length;
  return [
    http.get(apiUrl("/media/:id/detail"), ({ request, params }) => {
      record(db, request);
      const item = findItem(String(params.id));
      if (!item) return notFound();
      const state = socialOf(db, item.id);
      return HttpResponse.json({
        item,
        tags: state.tags,
        likes: { likeCount: state.likeCount, likedByMe: state.likedByMe },
        commentCount: liveCount(state),
        comments: { items: state.comments.slice(0, 20), nextCursor: state.comments.length > 20 ? "20" : null },
        canTag: state.canTag
      });
    }),
    http.get(apiUrl("/media/:id/tag-candidates"), ({ request, params }) => {
      const url = record(db, request);
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const state = socialOf(db, String(params.id));
      return HttpResponse.json({ items: state.candidates.filter((c) => c.name.toLowerCase().includes(q)) });
    }),
    http.post(apiUrl("/media/:id/tags"), async ({ request, params }) => {
      record(db, request);
      const body = (await request.json()) as { personId: string; x?: number; y?: number }; // Test fixture: `CreateMediaTagRequest`.
      db.bodies[`POST tags ${String(params.id)}`] = body;
      const state = socialOf(db, String(params.id));
      const existing = state.tags.find((t) => t.person.id === body.personId);
      if (existing) return HttpResponse.json(existing);
      const candidate = state.candidates.find((c) => c.id === body.personId);
      if (!candidate) {
        return HttpResponse.json(
          { error: { code: "VALIDATION", message: "No existe.", details: [{ path: "personId", message: "x", code: "TAG_NOT_ALLOWED" }] } },
          { status: 400 }
        );
      }
      db.nextId += 1;
      const tag: MediaTag = {
        id: uuid(db.nextId),
        person: { id: candidate.id, name: candidate.name, avatarUrl: candidate.avatarUrl },
        ...(body.x === undefined || body.y === undefined ? {} : { x: body.x, y: body.y }),
        status: state.nextTagStatus,
        isMe: candidate.isMe,
        canRemove: true,
        canApprove: false
      };
      state.tags.push(tag);
      return HttpResponse.json(tag, { status: 201 });
    }),
    http.post(apiUrl("/media/tags/:tagId/approve"), ({ request, params }) => {
      record(db, request);
      for (const state of Object.values(db.social)) {
        const tag = state.tags.find((t) => t.id === params.tagId && t.canApprove);
        if (tag) {
          tag.status = "approved";
          tag.canApprove = false;
          return HttpResponse.json(tag);
        }
      }
      return notFound();
    }),
    http.delete(apiUrl("/media/:id/tags/:tagId"), ({ request, params }) => {
      record(db, request);
      const state = socialOf(db, String(params.id));
      state.tags = state.tags.filter((t) => t.id !== params.tagId);
      return new HttpResponse(null, { status: 204 });
    }),
    http.put(apiUrl("/media/:id/like"), ({ request, params }) => {
      record(db, request);
      const state = socialOf(db, String(params.id));
      if (!state.likedByMe) state.likeCount += 1;
      state.likedByMe = true;
      return HttpResponse.json({ likeCount: state.likeCount, likedByMe: true });
    }),
    http.delete(apiUrl("/media/:id/like"), ({ request, params }) => {
      record(db, request);
      const state = socialOf(db, String(params.id));
      if (state.likedByMe) state.likeCount -= 1;
      state.likedByMe = false;
      return HttpResponse.json({ likeCount: state.likeCount, likedByMe: false });
    }),
    http.get(apiUrl("/media/:id/likes"), ({ request, params }) => {
      const url = record(db, request);
      return HttpResponse.json(paginate(socialOf(db, String(params.id)).likers, url));
    }),
    http.get(apiUrl("/media/:id/comments"), ({ request, params }) => {
      const url = record(db, request);
      return HttpResponse.json(paginate(socialOf(db, String(params.id)).comments, url));
    }),
    http.post(apiUrl("/media/:id/comments"), async ({ request, params }) => {
      record(db, request);
      const body = (await request.json()) as { body: string; clientCommentId: string }; // Test fixture: `CreateMediaCommentRequest`.
      const mediaId = String(params.id);
      const state = socialOf(db, mediaId);
      db.bodies[`POST comment ${body.clientCommentId}`] = body;
      db.nextId += 1;
      const comment: MediaComment = makeComment(db.nextId, mediaId, {
        id: uuid(db.nextId),
        body: body.body,
        author: { name: "Prima Morales", avatarUrl: null, isMe: true },
        canDelete: true
      });
      state.comments.push(comment);
      return HttpResponse.json(comment, { status: 201 });
    }),
    http.delete(apiUrl("/media/comments/:commentId"), ({ request, params }) => {
      record(db, request);
      for (const state of Object.values(db.social)) {
        const comment = state.comments.find((c) => c.id === params.commentId && c.canDelete);
        if (comment) {
          Object.assign(comment, { deleted: true, body: "", author: null, canDelete: false });
          return new HttpResponse(null, { status: 204 });
        }
      }
      return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
    }),
    http.post(apiUrl("/media/comments/:commentId/report"), async ({ request, params }) => {
      record(db, request);
      const id = String(params.commentId);
      db.bodies[`REPORT comment ${id}`] = await request.json();
      for (const state of Object.values(db.social)) {
        if (state.reported.includes(id)) return HttpResponse.json(errorBody("CONFLICT"), { status: 409 });
        if (state.comments.some((c) => c.id === id)) state.reported.push(id);
      }
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(apiUrl("/admin/media/comment-reports"), ({ request }) => {
      const url = record(db, request);
      const includeDeleted = url.searchParams.get("includeDeleted") === "true";
      return HttpResponse.json(paginate(db.commentReports.filter((c) => includeDeleted || c.deletedAt === null), url));
    }),
    http.delete(apiUrl("/admin/media/comments/:commentId"), ({ request, params }) => {
      record(db, request);
      const report = db.commentReports.find((c) => c.id === params.commentId);
      if (report) Object.assign(report, { deletedAt: new Date().toISOString(), body: "" });
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(apiUrl("/family/people/:personId/photos"), ({ request, params }) => {
      const url = record(db, request);
      return HttpResponse.json(paginate(db.personPhotos[String(params.personId)] ?? [], url));
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
