import { describe, expect, it } from "vitest";
import { mediaItemSchema } from "./media.js";
import * as barrel from "./index.js";
import {
  MEDIA_COMMENT_MAX_LENGTH,
  MEDIA_TAGS_MAX,
  SocialIssueCode,
  createMediaCommentInputSchema,
  createMediaTagInputSchema,
  mediaCommentSchema,
  mediaCommentsQuerySchema,
  mediaDetailSchema,
  mediaTagSchema,
  tagCandidatesQuerySchema
} from "./social.js";

const ID = "00000000-0000-4000-8000-000000000001";
const PERSON = "00000000-0000-4000-8000-000000000002";

const item = {
  id: ID,
  cuencadaId: null,
  year: null,
  kind: "image",
  mimeType: "image/jpeg",
  thumbUrl: null,
  displayUrl: null,
  width: 10,
  height: 10,
  durationSeconds: null,
  caption: null,
  uploaderName: "Ana Morales Vega",
  isMine: false,
  canEdit: false,
  canDelete: false,
  uploadStatus: "ready",
  moderationStatus: "approved",
  createdAt: "2026-10-11T10:00:00.000Z"
};

const comment = {
  id: ID,
  mediaId: ID,
  author: { name: "Bea Morales Vega", avatarUrl: null, isMe: false },
  body: "¡Qué bonita foto!",
  deleted: false,
  createdAt: "2026-10-11T10:00:00.000Z",
  canDelete: false,
  canModerate: false
};

describe("MediaItem (WP-6.0 additive fields)", () => {
  it("parses old shapes without the social fields and new ones with a Memory Box ref", () => {
    expect(mediaItemSchema.parse(item)).not.toHaveProperty("likeCount");
    const parsed = mediaItemSchema.parse({
      ...item,
      memoryAlbum: { id: ID, title: "Fotos de la abuela" },
      likeCount: 3,
      likedByMe: true,
      commentCount: 2,
      tagCount: 1
    });
    expect(parsed).toMatchObject({ memoryAlbum: { title: "Fotos de la abuela" }, likeCount: 3, likedByMe: true });
    expect(mediaItemSchema.safeParse({ ...item, likeCount: -1 }).success).toBe(false);
  });
});

describe("createMediaTagInputSchema", () => {
  it("accepts a person with or without a position, both coordinates or neither", () => {
    expect(createMediaTagInputSchema.parse({ personId: PERSON })).toEqual({ personId: PERSON });
    expect(createMediaTagInputSchema.parse({ personId: PERSON, x: 0, y: 1 })).toEqual({ personId: PERSON, x: 0, y: 1 });
    expect(createMediaTagInputSchema.safeParse({ personId: PERSON, x: 0.5 }).success).toBe(false);
    expect(createMediaTagInputSchema.safeParse({ personId: PERSON, x: 1.01, y: 0.5 }).success).toBe(false);
    expect(createMediaTagInputSchema.safeParse({ personId: PERSON, x: Number.NaN, y: 0.5 }).success).toBe(false);
  });

  it("is strict (no tagger or user id from the client)", () => {
    expect(createMediaTagInputSchema.safeParse({ personId: PERSON, taggedByUserId: ID }).success).toBe(false);
    expect(createMediaTagInputSchema.safeParse({ personId: "nope" }).success).toBe(false);
  });
});

describe("mediaTagSchema", () => {
  it("strips unknown keys, so an account id never leaks through a tag", () => {
    const tag = { id: ID, person: { id: PERSON, name: "Ana Morales Vega", avatarUrl: null, userId: ID }, isMe: false, canRemove: true };
    const parsed = mediaTagSchema.parse(tag);
    expect(parsed.person).not.toHaveProperty("userId");
    expect(parsed).not.toHaveProperty("x");
  });
});

describe("comments", () => {
  it("cleans the body: NFC, invisible marks stripped, CRLF to LF, trimmed, 1-1000 visible characters", () => {
    const parsed = createMediaCommentInputSchema.parse({ body: "  Hola​\r\nabuela  " });
    expect(parsed.body).toBe("Hola\nabuela");
    expect(createMediaCommentInputSchema.safeParse({ body: "   " }).success).toBe(false);
    expect(createMediaCommentInputSchema.safeParse({ body: "​‮" }).success).toBe(false);
    expect(createMediaCommentInputSchema.safeParse({ body: "x".repeat(MEDIA_COMMENT_MAX_LENGTH) }).success).toBe(true);
    expect(createMediaCommentInputSchema.safeParse({ body: "x".repeat(MEDIA_COMMENT_MAX_LENGTH + 1) }).success).toBe(false);
    expect(createMediaCommentInputSchema.parse({ body: "Hola", clientCommentId: ID }).clientCommentId).toBe(ID);
    expect(createMediaCommentInputSchema.safeParse({ body: "Hola", authorUserId: ID }).success).toBe(false);
  });

  it("only accepts tombstones without body or author", () => {
    expect(mediaCommentSchema.parse(comment)).toEqual(comment);
    const tombstone = { ...comment, author: null, body: "", deleted: true };
    expect(mediaCommentSchema.parse(tombstone)).toEqual(tombstone);
    expect(mediaCommentSchema.safeParse({ ...tombstone, body: "texto borrado" }).success).toBe(false);
    expect(mediaCommentSchema.safeParse({ ...tombstone, author: comment.author }).success).toBe(false);
  });

  it("pages 1-50 comments, 20 by default", () => {
    expect(mediaCommentsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(mediaCommentsQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
  });
});

describe("mediaDetailSchema", () => {
  it("parses a detail and caps the tag list", () => {
    const tag = { id: ID, person: { id: PERSON, name: "Ana Morales Vega", avatarUrl: null }, isMe: true, canRemove: true };
    const detail = {
      item,
      tags: [tag],
      likes: { likeCount: 1, likedByMe: false },
      commentCount: 1,
      comments: { items: [comment], nextCursor: null },
      canTag: true
    };
    expect(mediaDetailSchema.parse(detail)).toEqual(detail);
    const tooMany = { ...detail, tags: Array.from({ length: MEDIA_TAGS_MAX + 1 }, () => tag) };
    expect(mediaDetailSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe("tag candidates and codes", () => {
  it("needs a search term and caps the limit", () => {
    expect(tagCandidatesQuerySchema.safeParse({ q: " " }).success).toBe(false);
    expect(tagCandidatesQuerySchema.parse({ q: "Ana" })).toEqual({ q: "Ana", limit: 10 });
    expect(tagCandidatesQuerySchema.safeParse({ q: "Ana", limit: 21 }).success).toBe(false);
  });

  it("exports the open detail codes and the schemas from the barrel", () => {
    expect(Object.values(SocialIssueCode)).toEqual(["TAG_NOT_ALLOWED", "TAG_LIMIT", "COMMENT_NOT_FOUND"]);
    expect(barrel.mediaDetailSchema).toBe(mediaDetailSchema);
    expect(barrel.SocialIssueCode).toBe(SocialIssueCode);
  });
});
