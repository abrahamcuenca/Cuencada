/**
 * Memory Box test fixtures (WP-6.3): fictional boxes and an in-memory
 * "server" for MSW following the WP-6.0 route list (member and admin).
 * Every title is invented (public repo). Imported by tests only.
 */
import type { AdminMemoryAlbum, MediaItem, MemoryAlbumStatus } from "@cuencada/types";
import { HttpResponse, http, type HttpHandler } from "msw";
import { apiUrl, errorBody } from "../../../../test/auth";
import { makeMedia } from "../../gallery/testUtils";

/** A v4-shaped UUID for fixture `n` (namespace 6 = memories). */
export function memoryId(n: number): string {
  return `66666666-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** An admin box (the member shapes are subsets). */
export function makeBox(n: number, overrides: Partial<AdminMemoryAlbum> = {}): AdminMemoryAlbum {
  return {
    id: memoryId(n),
    title: `Fotos antiguas ${n}`,
    description: "Escaneadas por la Rama Norte.",
    coverUrl: null,
    mediaCount: 0,
    updatedAt: "2026-09-01T15:00:00.000Z",
    status: "published",
    sortOrder: n - 1,
    coverMediaId: null,
    createdByName: "Rosa Quintero Lara",
    createdAt: "2026-09-01T15:00:00.000Z",
    ...overrides
  };
}

/** A box photo (the gallery fixture with the box ref). */
export function makeBoxMedia(n: number, box: Pick<AdminMemoryAlbum, "id" | "title">, overrides: Partial<MediaItem> = {}): MediaItem {
  return makeMedia(n, { cuencadaId: null, year: null, album: null, event: null, memoryAlbum: { id: box.id, title: box.title }, ...overrides });
}

/** The fake server state. */
export interface MemoriesDb {
  boxes: AdminMemoryAlbum[];
  /** Media per box id. */
  media: Map<string, MediaItem[]>;
  /** Viewer is an admin (sees every status; `canUpload` everywhere). */
  admin: boolean;
  /** Request log: `METHOD /path?query`. */
  log: string[];
  /** Bodies by log line. */
  bodies: Map<string, unknown>;
  /** The next write fails with this error. */
  failNext: { status: number; detailCode?: string; message: string } | null;
}

/** A fresh fake server. */
export function makeMemoriesDb(overrides: Partial<MemoriesDb> = {}): MemoriesDb {
  return { boxes: [], media: new Map(), admin: false, log: [], bodies: new Map(), failNext: null, ...overrides };
}

function record(db: MemoriesDb, request: Request): string {
  const url = new URL(request.url);
  const line = `${request.method} ${url.pathname.replace(/^\/api/, "")}${url.search}`;
  db.log.push(line);
  return line;
}

async function readBody(db: MemoriesDb, line: string, request: Request): Promise<unknown> {
  const body: unknown = await request.json();
  db.bodies.set(line, body);
  return body;
}

function failure(db: MemoriesDb): Response | null {
  const forced = db.failNext;
  if (forced === null) return null;
  db.failNext = null;
  const body = errorBody(forced.status === 409 ? "CONFLICT" : "VALIDATION", forced.message);
  if (forced.detailCode !== undefined) body.error.details = [{ path: "memoryAlbum", message: forced.message, code: forced.detailCode }];
  return HttpResponse.json(body, { status: forced.status });
}

function notFound(): Response {
  const body = errorBody("NOT_FOUND", "No encontramos ese baúl de recuerdos.");
  body.error.details = [{ path: "memoryAlbum", message: "No encontramos ese baúl de recuerdos.", code: "MEMORY_ALBUM_NOT_FOUND" }];
  return HttpResponse.json(body, { status: 404 });
}

function visible(db: MemoriesDb, id: string): AdminMemoryAlbum | undefined {
  const box = db.boxes.find((entry) => entry.id === id);
  if (box === undefined) return undefined;
  return db.admin || box.status === "published" ? box : undefined;
}

function summary(box: AdminMemoryAlbum): Omit<AdminMemoryAlbum, "status" | "sortOrder" | "coverMediaId" | "createdByName" | "createdAt"> {
  const { status: _status, sortOrder: _sort, coverMediaId: _cover, createdByName: _by, createdAt: _at, ...rest } = box;
  return rest;
}

/** MSW handlers over {@link MemoriesDb}. */
export function memoriesHandlers(db: MemoriesDb): HttpHandler[] {
  return [
    http.get(apiUrl("/memories"), ({ request }) => {
      record(db, request);
      return HttpResponse.json({ items: db.boxes.filter((box) => box.status === "published").map(summary) });
    }),
    http.get(apiUrl("/memories/:id"), ({ params, request }) => {
      record(db, request);
      const box = visible(db, String(params.id));
      if (box === undefined) return notFound();
      return HttpResponse.json({ ...summary(box), canUpload: db.admin || box.status === "published" });
    }),
    http.get(apiUrl("/memories/:id/media"), ({ params, request }) => {
      record(db, request);
      const box = visible(db, String(params.id));
      if (box === undefined) return notFound();
      return HttpResponse.json({ items: db.media.get(box.id) ?? [], nextCursor: null });
    }),
    http.post(apiUrl("/memories/:id/uploads"), async ({ params, request }) => {
      const line = record(db, request);
      await readBody(db, line, request);
      const box = visible(db, String(params.id));
      if (box === undefined) return notFound();
      return HttpResponse.json(
        {
          mediaId: memoryId(700),
          uploadUrl: `https://bucket.example/memories/${box.id}/originals/x.jpg?X-Amz-Signature=s`,
          headers: { "Content-Type": "image/jpeg" },
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
        },
        { status: 201 }
      );
    }),
    http.get(apiUrl("/admin/memory-albums"), ({ request }) => {
      record(db, request);
      return HttpResponse.json({ items: db.boxes });
    }),
    http.post(apiUrl("/admin/memory-albums"), async ({ request }) => {
      const line = record(db, request);
      const body = (await readBody(db, line, request)) as { title: string; description?: string | null; status?: MemoryAlbumStatus }; // Test-only.
      const forced = failure(db);
      if (forced !== null) return forced;
      const box = makeBox(db.boxes.length + 1, { title: body.title, description: body.description ?? null, status: body.status ?? "draft", sortOrder: 0 });
      db.boxes = [box, ...db.boxes];
      return HttpResponse.json(box, { status: 201 });
    }),
    http.put(apiUrl("/admin/memory-albums/order"), async ({ request }) => {
      const line = record(db, request);
      const body = (await readBody(db, line, request)) as { ids: string[] }; // Test-only.
      const forced = failure(db);
      if (forced !== null) return forced;
      db.boxes = body.ids.flatMap((id, index) => {
        const box = db.boxes.find((entry) => entry.id === id);
        return box === undefined ? [] : [{ ...box, sortOrder: index }];
      });
      return HttpResponse.json({ items: db.boxes });
    }),
    http.patch(apiUrl("/admin/memory-albums/:id"), async ({ params, request }) => {
      const line = record(db, request);
      const body = (await readBody(db, line, request)) as Partial<AdminMemoryAlbum>; // Test-only.
      const forced = failure(db);
      if (forced !== null) return forced;
      const box = db.boxes.find((entry) => entry.id === params.id);
      if (box === undefined) return notFound();
      const next = { ...box, ...body };
      db.boxes = db.boxes.map((entry) => (entry.id === box.id ? next : entry));
      return HttpResponse.json(next);
    }),
    http.delete(apiUrl("/admin/memory-albums/:id"), ({ params, request }) => {
      record(db, request);
      const forced = failure(db);
      if (forced !== null) return forced;
      db.boxes = db.boxes.filter((entry) => entry.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    })
  ];
}
