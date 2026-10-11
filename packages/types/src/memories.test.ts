import { describe, expect, it } from "vitest";
import { AuditAction, AuditEntityType, auditActionSchema } from "./admin.js";
import * as barrel from "./index.js";
import {
  MEMORY_ALBUMS_MAX,
  MemoryIssueCode,
  adminMemoryAlbumSchema,
  createMemoryAlbumInputSchema,
  memoryAlbumDetailSchema,
  reorderMemoryAlbumsInputSchema,
  updateMemoryAlbumInputSchema
} from "./memories.js";

const ID = "00000000-0000-4000-8000-000000000001";

describe("Memory Box inputs", () => {
  it("creates a draft by default with a cleaned one-line title", () => {
    expect(createMemoryAlbumInputSchema.parse({ title: "  Fotos de la abuela​ " })).toEqual({
      title: "Fotos de la abuela",
      description: null,
      status: "draft",
      sortOrder: 0
    });
    expect(createMemoryAlbumInputSchema.safeParse({ title: "Dos\nlíneas" }).success).toBe(false);
    expect(createMemoryAlbumInputSchema.safeParse({ title: "x".repeat(121) }).success).toBe(false);
    expect(createMemoryAlbumInputSchema.safeParse({ title: "Caja", status: "archived" }).success).toBe(false);
    expect(createMemoryAlbumInputSchema.safeParse({ title: "Caja", createdByUserId: ID }).success).toBe(false);
  });

  it("keeps multi-line descriptions and turns blank ones into null", () => {
    expect(createMemoryAlbumInputSchema.parse({ title: "Caja", description: "Una\nfoto" }).description).toBe("Una\nfoto");
    expect(createMemoryAlbumInputSchema.parse({ title: "Caja", description: "  " }).description).toBeNull();
    expect(createMemoryAlbumInputSchema.safeParse({ title: "Caja", description: "d".repeat(2001) }).success).toBe(false);
  });

  it("updates at least one field and accepts clearing the cover", () => {
    expect(updateMemoryAlbumInputSchema.safeParse({}).success).toBe(false);
    expect(updateMemoryAlbumInputSchema.parse({ coverMediaId: null })).toEqual({ coverMediaId: null });
    expect(updateMemoryAlbumInputSchema.parse({ status: "published" })).toEqual({ status: "published" });
    expect(updateMemoryAlbumInputSchema.safeParse({ sortOrder: 1001 }).success).toBe(false);
  });

  it("reorders distinct ids only", () => {
    expect(reorderMemoryAlbumsInputSchema.safeParse({ ids: [ID, ID] }).success).toBe(false);
    expect(reorderMemoryAlbumsInputSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(reorderMemoryAlbumsInputSchema.parse({ ids: [ID] })).toEqual({ ids: [ID] });
    expect(MEMORY_ALBUMS_MAX).toBe(200);
  });
});

describe("Memory Box read models", () => {
  const summary = {
    id: ID,
    title: "Fotos de la abuela",
    description: null,
    coverUrl: null,
    mediaCount: 4,
    updatedAt: "2026-10-11T10:00:00.000Z"
  };

  it("parses member and admin shapes; members never get the status or creator", () => {
    expect(memoryAlbumDetailSchema.parse({ ...summary, canUpload: true, status: "draft", createdByName: "Admin" })).toEqual({
      ...summary,
      canUpload: true
    });
    const admin = { ...summary, status: "hidden", sortOrder: 2, coverMediaId: null, createdByName: null, createdAt: summary.updatedAt };
    expect(adminMemoryAlbumSchema.parse(admin)).toEqual(admin);
  });
});

describe("WP-6.0 audit vocabulary", () => {
  it("adds valid dotted actions and the new entity types", () => {
    const added = [
      AuditAction.MediaTagged,
      AuditAction.MediaUntagged,
      AuditAction.MediaCommentDeleted,
      AuditAction.MemoryAlbumCreated,
      AuditAction.TreeProposalApproved,
      AuditAction.FamilySettingsUpdated
    ];
    for (const action of added) expect(auditActionSchema.safeParse(action).success, action).toBe(true);
    expect(AuditEntityType.MemoryAlbum).toBe("memory_album");
    expect(MemoryIssueCode.NotFound).toBe("MEMORY_ALBUM_NOT_FOUND");
    expect(barrel.createMemoryAlbumInputSchema).toBe(createMemoryAlbumInputSchema);
  });
});
