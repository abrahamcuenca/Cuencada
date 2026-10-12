/**
 * Memory Box fixtures (WP-6.3): boxes and box media inserted directly
 * (fictional titles only; the repository is public).
 */
import { randomUUID } from "node:crypto";
import type { MemoryAlbumStatus } from "@cuencada/types";
import { mediaItems, memoryAlbums } from "../../src/db/schema/index.js";
import { getTestDb } from "./db.js";

type MemoryAlbumRow = typeof memoryAlbums.$inferSelect;
type MediaRow = typeof mediaItems.$inferSelect;
type MediaInsert = typeof mediaItems.$inferInsert;

/** Options for {@link insertMemoryAlbum}. */
export interface InsertMemoryAlbumOptions {
  title?: string;
  description?: string | null;
  status?: MemoryAlbumStatus;
  sortOrder?: number;
  createdByUserId?: string | null;
  createdAt?: Date;
}

/** Insert a box (published by default). */
export async function insertMemoryAlbum(options: InsertMemoryAlbumOptions = {}): Promise<MemoryAlbumRow> {
  const [row] = await getTestDb()
    .insert(memoryAlbums)
    .values({
      title: options.title ?? "Fotos de la Rama Norte",
      description: options.description ?? null,
      status: options.status ?? "published",
      sortOrder: options.sortOrder ?? 0,
      createdByUserId: options.createdByUserId ?? null,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt })
    })
    .returning();
  if (row === undefined) throw new Error("insertMemoryAlbum: no row");
  return row;
}

/**
 * Insert a media row in a box (prefix and keys under `memories/{albumId}`;
 * a ready, approved photo by default).
 */
export async function insertMemoryMedia(album: Pick<MemoryAlbumRow, "id">, values: Partial<MediaInsert> = {}): Promise<MediaRow> {
  const id = values.id ?? randomUUID();
  const prefix = `memories/${album.id}`;
  const [row] = await getTestDb()
    .insert(mediaItems)
    .values({
      id,
      cuencadaId: null,
      albumId: null,
      memoryAlbumId: album.id,
      storagePrefix: prefix,
      kind: "image",
      objectKey: `${prefix}/originals/${id}.jpg`,
      thumbKey: `${prefix}/thumbs/${id}.webp`,
      displayKey: `${prefix}/display/${id}.webp`,
      bucket: "test-bucket",
      fileName: "recuerdo.jpg",
      mimeType: "image/jpeg",
      byteSize: 1000,
      width: 1600,
      height: 1200,
      uploadStatus: "ready",
      moderationStatus: "approved",
      ...values
    })
    .returning();
  if (row === undefined) throw new Error("insertMemoryMedia: no row");
  return row;
}
