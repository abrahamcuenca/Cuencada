/**
 * Memory Box ("Baúl de recuerdos", WP-6.0 contracts; WP-6.3 implements):
 * admin-created photo albums that belong to no edition and no event. Any
 * verified member adds photos to a **published** box and tags people in
 * them; admins create, edit, publish, hide, reorder and delete boxes.
 * Authorization: ADR 0001 §8 (binding).
 *
 * Box media are ordinary `media_items` rows with `memory_album_id` set (the
 * third media scope) and `storage_prefix = memories/{albumId}`; they reuse
 * the gallery upload, confirm, processing, moderation and social routes.
 *
 * Re-exported by `cuencadas.ts` (the barrel is frozen).
 */
import { z } from "zod";
import { dateTimeSchema, idSchema } from "./common.js";
import { MEMORY_ALBUM_TITLE_MAX_LENGTH } from "./eventRefs.js";
import { cleanNullableTextSchema, singleLineTextSchema } from "./events.js";

/** Longest box description (DB CHECK `memory_albums_description_length_check`). */
export const MEMORY_ALBUM_DESCRIPTION_MAX_LENGTH = 2000;
/** Largest `sort_order` (DB CHECK `memory_albums_sort_order_check`). */
export const MEMORY_ALBUM_SORT_ORDER_MAX = 1000;
/** Most boxes listed (and reordered) at once. */
export const MEMORY_ALBUMS_MAX = 200;

/**
 * `draft`: being prepared, admins only. `published`: visible to every
 * verified member, who may upload. `hidden`: taken down, admins only (its
 * media disappear from members' views, social routes included).
 */
export const MemoryAlbumStatus = {
  Draft: "draft",
  Published: "published",
  Hidden: "hidden"
} as const;
export type MemoryAlbumStatus = (typeof MemoryAlbumStatus)[keyof typeof MemoryAlbumStatus];
export const memoryAlbumStatusSchema = z.enum(MemoryAlbumStatus);

/**
 * Stable reasons on Memory Box errors (`error.details[0].code`, the open
 * detail-code channel of ADR 0001 §4), sent with `path: "memoryAlbum"`.
 */
export const MemoryIssueCode = {
  /** 404 `NOT_FOUND`: no such box, or one the caller cannot see (drafts and hidden boxes for members). */
  NotFound: "MEMORY_ALBUM_NOT_FOUND",
  /** 409 `CONFLICT` on delete: the box still has live media (soft-deleted rows are purged). */
  NotEmpty: "MEMORY_ALBUM_NOT_EMPTY"
} as const;
export type MemoryIssueCode = (typeof MemoryIssueCode)[keyof typeof MemoryIssueCode];

/** Box title: one line, 1–120 characters. */
export const memoryAlbumTitleSchema = singleLineTextSchema(MEMORY_ALBUM_TITLE_MAX_LENGTH);
/** Box description: optional, multi-line, ≤ 2000 characters, `null` when blank. */
export const memoryAlbumDescriptionSchema = cleanNullableTextSchema(MEMORY_ALBUM_DESCRIPTION_MAX_LENGTH, true);

/** A box card (`GET /api/memories`). */
export interface MemoryAlbumSummary {
  id: string;
  title: string;
  description: string | null;
  /** Presigned 400 px thumbnail of the cover photo (only while that photo is visible), else `null`. */
  coverUrl: string | null;
  /** Photos and videos the caller can see in the box. */
  mediaCount: number;
  updatedAt: string;
}

export const memoryAlbumSummarySchema = z.object({
  id: idSchema,
  title: z.string().max(MEMORY_ALBUM_TITLE_MAX_LENGTH),
  description: z.string().max(MEMORY_ALBUM_DESCRIPTION_MAX_LENGTH).nullable(),
  coverUrl: z.string().max(4096).nullable(),
  mediaCount: z.number().int().min(0),
  updatedAt: dateTimeSchema
}) satisfies z.ZodType<MemoryAlbumSummary>;

/** `GET /api/memories/:id`. */
export interface MemoryAlbumDetail extends MemoryAlbumSummary {
  /** The caller may upload (verified members on published boxes; admins always). */
  canUpload: boolean;
}

export const memoryAlbumDetailSchema = memoryAlbumSummarySchema.extend({
  canUpload: z.boolean()
}) satisfies z.ZodType<MemoryAlbumDetail>;

/** `GET /api/memories`: published boxes by `sort_order`, then newest. */
export const memoryAlbumListSchema = z.object({
  items: z.array(memoryAlbumSummarySchema).max(MEMORY_ALBUMS_MAX)
});
export type MemoryAlbumList = z.infer<typeof memoryAlbumListSchema>;

/** A box in the admin panel (every status). */
export interface AdminMemoryAlbum extends MemoryAlbumSummary {
  status: MemoryAlbumStatus;
  sortOrder: number;
  coverMediaId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export const adminMemoryAlbumSchema = memoryAlbumSummarySchema.extend({
  status: memoryAlbumStatusSchema,
  sortOrder: z.number().int().min(0).max(MEMORY_ALBUM_SORT_ORDER_MAX),
  coverMediaId: idSchema.nullable(),
  createdByName: z.string().max(80).nullable(),
  createdAt: dateTimeSchema
}) satisfies z.ZodType<AdminMemoryAlbum>;

/** `GET /api/admin/memory-albums`. */
export const adminMemoryAlbumListSchema = z.object({
  items: z.array(adminMemoryAlbumSchema).max(MEMORY_ALBUMS_MAX)
});
export type AdminMemoryAlbumList = z.infer<typeof adminMemoryAlbumListSchema>;

const sortOrderSchema = z.number().int().min(0).max(MEMORY_ALBUM_SORT_ORDER_MAX);

/** `POST /api/admin/memory-albums` (admin). */
export const createMemoryAlbumInputSchema = z.strictObject({
  title: memoryAlbumTitleSchema,
  description: memoryAlbumDescriptionSchema.default(null),
  status: memoryAlbumStatusSchema.default(MemoryAlbumStatus.Draft),
  sortOrder: sortOrderSchema.default(0)
});
export type CreateMemoryAlbumInput = z.infer<typeof createMemoryAlbumInputSchema>;
export type CreateMemoryAlbumRequest = z.input<typeof createMemoryAlbumInputSchema>;

/**
 * `PATCH /api/admin/memory-albums/:id` (admin). `coverMediaId` must be a
 * live, ready media item **of this box** (else 400 `VALIDATION`); `null`
 * clears it.
 */
export const updateMemoryAlbumInputSchema = z
  .strictObject({
    title: memoryAlbumTitleSchema,
    description: memoryAlbumDescriptionSchema,
    status: memoryAlbumStatusSchema,
    sortOrder: sortOrderSchema,
    coverMediaId: idSchema.nullable()
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type UpdateMemoryAlbumInput = z.infer<typeof updateMemoryAlbumInputSchema>;
export type UpdateMemoryAlbumRequest = z.input<typeof updateMemoryAlbumInputSchema>;

/** `PUT /api/admin/memory-albums/order` (admin): every box id in the new order (`sort_order` = index). */
export const reorderMemoryAlbumsInputSchema = z.strictObject({
  ids: z
    .array(idSchema)
    .min(1)
    .max(MEMORY_ALBUMS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { error: "Hay baúles repetidos." })
});
export type ReorderMemoryAlbumsInput = z.infer<typeof reorderMemoryAlbumsInputSchema>;
export type ReorderMemoryAlbumsRequest = z.input<typeof reorderMemoryAlbumsInputSchema>;
