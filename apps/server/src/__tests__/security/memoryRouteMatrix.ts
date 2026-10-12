/**
 * Authorization-matrix entries for the Memory Box routes (WP-6.3) [SEC].
 * Spread into `ROUTE_MATRIX` (`routeMatrix.ts`); same contract: a minimal
 * valid request for `ctx.actor` plus probes run as a verified member.
 *
 * Probes: on every `/api/memories/:id…` route a draft and a hidden box
 * answer 404 `MEMORY_ALBUM_NOT_FOUND` and change nothing (ADR 0001 §8,
 * requirements 1 and 5). {@link memoryMediaProbes} adds the same cases to
 * the gallery's by-id routes (`/api/media/:id…`): a photo in a draft or
 * hidden box is 404 there too, even for its own uploader.
 */
import type { MemoryAlbumStatus } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { mediaItems, mediaReports, memoryAlbums } from "../../db/schema/index.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { insertMemoryAlbum, insertMemoryMedia } from "../../../test/helpers/memories.js";
import type { Actor, BuiltRequest, Expectation, MatrixContext, Probe, ProbeRequest, RouteSpec } from "./routeMatrix.js";

const NOT_FOUND: Expectation = { status: 404, code: "NOT_FOUND" };

const json = (url: string, payload?: unknown): BuiltRequest => (payload === undefined ? { url } : { url, payload });

const UPLOAD = { fileName: "foto.png", mimeType: "image/png", byteSize: 1000 } as const;

/** A box and every media row in it: what a probe must not change. */
function boxState(albumId: string): () => Promise<unknown> {
  return async () => ({
    box: await getTestDb().select().from(memoryAlbums).where(eq(memoryAlbums.id, albumId)),
    media: await getTestDb().select().from(mediaItems).where(eq(mediaItems.memoryAlbumId, albumId)).orderBy(mediaItems.id)
  });
}

type BoxRequest = (ctx: MatrixContext, albumId: string) => Promise<BuiltRequest> | BuiltRequest;

/** A draft and a hidden box: 404 and no change. */
function invisibleBoxProbes(request: BoxRequest): Probe[] {
  return (["draft", "hidden"] as const).map((status) => ({
    label: `a ${status} box`,
    kind: "idor",
    build: async (ctx): Promise<ProbeRequest> => {
      const box = await insertMemoryAlbum({ status, title: "Baúl de prueba" });
      await insertMemoryMedia(box, { uploadedByUserId: ctx.other.user.id });
      return { ...(await request(ctx, box.id)), state: boxState(box.id) };
    },
    expect: NOT_FOUND
  }));
}

/** A photo by `uploader` in a fresh box with `status`. */
async function boxPhoto(uploader: Actor, status: MemoryAlbumStatus, values: Parameters<typeof insertMemoryMedia>[1] = {}): Promise<string> {
  const box = await insertMemoryAlbum({ status });
  return (await insertMemoryMedia(box, { uploadedByUserId: uploader.user.id, ...values })).id;
}

function mediaRowState(id: string): () => Promise<unknown> {
  return async () => ({
    item: await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, id)),
    reports: await getTestDb().select().from(mediaReports).where(eq(mediaReports.mediaId, id))
  });
}

/**
 * Probes for the gallery's by-id routes: a photo in a draft or hidden box,
 * uploaded by the caller (the strongest case) or by another member, is 404.
 *
 * @param request - Builds the route's request for a media id.
 * @param pending - Use a `pending_upload` row (confirm).
 */
export function memoryMediaProbes(request: (id: string) => BuiltRequest, pending = false): Probe[] {
  return (["draft", "hidden"] as const).flatMap((status) =>
    (["own", "another member's"] as const).map(
      (whose): Probe => ({
        label: `${whose} photo in a ${status} Memory Box`,
        kind: "idor",
        build: async (ctx) => {
          const id = await boxPhoto(whose === "own" ? ctx.actor : ctx.other, status, pending ? { uploadStatus: "pending_upload" } : {});
          return { ...request(id), state: mediaRowState(id) };
        },
        expect: NOT_FOUND
      })
    )
  );
}

const member = { auth: "user", requireVerifiedEmail: true } as const;

export const MEMORY_ROUTE_SPECS: RouteSpec[] = [
  {
    method: "GET",
    url: "/api/memories",
    ...member,
    note: "published boxes only (drafts and hidden boxes never listed)",
    build: async () => json("/api/memories")
  },
  {
    method: "GET",
    url: "/api/memories/:id",
    ...member,
    owner: "published boxes for members; admins any (404 MEMORY_ALBUM_NOT_FOUND)",
    build: async () => json(`/api/memories/${(await insertMemoryAlbum()).id}`),
    probes: invisibleBoxProbes((_ctx, id) => json(`/api/memories/${id}`))
  },
  {
    method: "GET",
    url: "/api/memories/:id/media",
    ...member,
    owner: "published boxes for members; admins any (404 MEMORY_ALBUM_NOT_FOUND)",
    build: async () => json(`/api/memories/${(await insertMemoryAlbum()).id}/media`),
    probes: invisibleBoxProbes((_ctx, id) => json(`/api/memories/${id}/media`))
  },
  {
    method: "POST",
    url: "/api/memories/:id/uploads",
    ...member,
    owner: "any verified member to a published box; admins any; shared daily upload budget",
    build: async () => json(`/api/memories/${(await insertMemoryAlbum()).id}/uploads`, UPLOAD),
    probes: invisibleBoxProbes((_ctx, id) => json(`/api/memories/${id}/uploads`, UPLOAD))
  },
  // ------------------------------------------------------------------ admin
  {
    method: "GET",
    url: "/api/admin/memory-albums",
    auth: "admin",
    note: "every box, drafts and hidden included",
    build: async () => json("/api/admin/memory-albums")
  },
  {
    method: "POST",
    url: "/api/admin/memory-albums",
    auth: "admin",
    note: "draft by default; audited",
    build: async () => json("/api/admin/memory-albums", { title: "Fotos de la Rama Norte" })
  },
  {
    method: "PATCH",
    url: "/api/admin/memory-albums/:id",
    auth: "admin",
    note: "cover must be a photo of this box (400); publish/hide audited",
    build: async () => json(`/api/admin/memory-albums/${(await insertMemoryAlbum({ status: "draft" })).id}`, { status: "published" })
  },
  {
    method: "DELETE",
    url: "/api/admin/memory-albums/:id",
    auth: "admin",
    note: "409 MEMORY_ALBUM_NOT_EMPTY with live media; purges soft-deleted rows",
    build: async () => json(`/api/admin/memory-albums/${(await insertMemoryAlbum()).id}`)
  },
  {
    method: "PUT",
    url: "/api/admin/memory-albums/order",
    auth: "admin",
    note: "every box id (409 when the set changed)",
    build: async () => {
      const boxes = await getTestDb().select({ id: memoryAlbums.id }).from(memoryAlbums);
      const ids = boxes.length > 0 ? boxes.map((box) => box.id) : [(await insertMemoryAlbum()).id];
      return json("/api/admin/memory-albums/order", { ids });
    }
  }
];
