import { describe, expect, it } from "vitest";
import { AuditAction, AuditEntityType } from "./admin.js";
import { ChatRoomKind, chatRoomSchema, wsServerMessageSchema } from "./chat.js";
import {
  EVENT_COVER_ASPECT,
  EVENT_SLUG_FALLBACK,
  EVENT_SLUG_MAX_LENGTH,
  EVENT_SLUG_PATTERN,
  EVENT_SLUG_SUFFIX_LENGTH,
  EventIssueCode,
  addEventParticipantsInputSchema,
  adminCreateEventInputSchema,
  adminUpdateEventInputSchema,
  clampAspectCropRect,
  createEventAlbumInputSchema,
  createEventInputSchema,
  emptyEventBodySchema,
  eventCoverConfirmBodySchema,
  eventDatesIssue,
  eventDetailSchema,
  eventListQuerySchema,
  eventParticipantSchema,
  eventPathParamsSchema,
  eventSlugSchema,
  eventSlugWithSuffix,
  eventYearOf,
  foldAccents,
  isEventSlug,
  isPastEvent,
  randomEventSlugSuffix,
  slugifyEventTitle,
  updateEventAlbumInputSchema,
  updateEventInputSchema
} from "./events.js";
import { mediaItemSchema } from "./media.js";
import * as barrel from "./index.js";

const eventId = "6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const albumId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const userId = "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";
const otherUserId = "2c3d4e5f-6071-4c8d-8e9f-1a2b3c4d5e6f";

describe("foldAccents", () => {
  it("removes Spanish accents, tildes and diaeresis, keeping case", () => {
    expect(foldAccents("Mérida, Año Nuevo, pingüino ÁÉÍÓÚ Ñ")).toBe("Merida, Ano Nuevo, pinguino AEIOU N");
  });

  it("folds letters NFD keeps whole", () => {
    expect(foldAccents("Straße Øresund Łódź")).toBe("Strasse Oresund Lodz");
  });
});

describe("slugifyEventTitle", () => {
  it("builds a lowercase dashed slug without accents", () => {
    expect(slugifyEventTitle("Viaje a Ciudad de México 2026")).toBe("viaje-a-ciudad-de-mexico-2026");
    expect(slugifyEventTitle("  ¡Carne asada en casa de la Tía Lupe!  ")).toBe("carne-asada-en-casa-de-la-tia-lupe");
    expect(slugifyEventTitle("Cumpleaños 🎉🎂 de Ñoño")).toBe("cumpleanos-de-nono");
  });

  it("falls back when fewer than 3 usable characters remain", () => {
    expect(slugifyEventTitle("🎉🎉")).toBe(EVENT_SLUG_FALLBACK);
    expect(slugifyEventTitle("Yo")).toBe(EVENT_SLUG_FALLBACK);
    expect(slugifyEventTitle("Día")).toBe("dia");
  });

  it("cuts long titles at a word boundary within 60 characters", () => {
    const slug = slugifyEventTitle(`${"palabra ".repeat(12)}final`);
    expect(slug.length).toBeLessThanOrEqual(EVENT_SLUG_MAX_LENGTH);
    expect(slug.endsWith("palabra")).toBe(true);
    expect(isEventSlug(slug)).toBe(true);
  });

  it("cuts a single long word hard when no boundary exists", () => {
    const slug = slugifyEventTitle("a".repeat(80));
    expect(slug).toBe("a".repeat(EVENT_SLUG_MAX_LENGTH));
  });

  it("always produces a slug the DB pattern accepts", () => {
    const pattern = new RegExp(EVENT_SLUG_PATTERN);
    for (const title of ["--x--", "A  B  C", `${"x".repeat(59)} y`, "Ñandú — 2026/27", "🎉 fiesta 🎉", "123"]) {
      const slug = slugifyEventTitle(title);
      expect(pattern.test(slug), `${title} → ${slug}`).toBe(true);
      expect(isEventSlug(slug), slug).toBe(true);
    }
  });
});

describe("eventSlugWithSuffix", () => {
  it("appends the given suffix and stays within 60 characters", () => {
    expect(eventSlugWithSuffix("carne-asada", "k7q2")).toBe("carne-asada-k7q2");
    const long = slugifyEventTitle("x".repeat(60));
    const suffixed = eventSlugWithSuffix(long, "ab23");
    expect(suffixed.length).toBeLessThanOrEqual(EVENT_SLUG_MAX_LENGTH);
    expect(suffixed.endsWith("-ab23")).toBe(true);
    expect(isEventSlug(suffixed)).toBe(true);
    const words = eventSlugWithSuffix(slugifyEventTitle(`${"palabra ".repeat(7)}final`), "zz77");
    expect(words.length).toBeLessThanOrEqual(EVENT_SLUG_MAX_LENGTH);
    expect(words).toMatch(/palabra-zz77$/);
  });

  it("uses a random base32 suffix by default, not a sequence (Security M1)", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const slug = eventSlugWithSuffix("carne-asada");
      expect(slug).toMatch(/^carne-asada-[a-z2-7]{4}$/);
      expect(isEventSlug(slug)).toBe(true);
      seen.add(slug);
    }
    // 50 draws from 32^4 values: a repeat is possible but many repeats mean no randomness.
    expect(seen.size).toBeGreaterThan(45);
    const suffix = randomEventSlugSuffix();
    expect(suffix).toHaveLength(EVENT_SLUG_SUFFIX_LENGTH);
  });

  it("rejects a suffix that is not 4 base32 characters", () => {
    for (const bad of ["2", "abc", "abcde", "ab-c", "AB23", "ab18"]) {
      expect(() => eventSlugWithSuffix("carne-asada", bad), bad).toThrow(RangeError);
    }
  });
});

describe("eventSlugSchema", () => {
  it("lowercases and trims, then checks the pattern and length", () => {
    expect(eventSlugSchema.parse("  Carne-Asada ")).toBe("carne-asada");
    for (const bad of ["ab", "-abc", "abc-", "a--b", "méxico", "a b c", "a_b", "x".repeat(61), ""]) {
      expect(eventSlugSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("eventYearOf", () => {
  it("uses the event's timezone, not UTC", () => {
    // 05:00 UTC on Jan 1 is still Dec 31 in Mérida (UTC−6).
    expect(eventYearOf("2027-01-01T05:00:00Z", "America/Merida")).toBe(2026);
    expect(eventYearOf("2027-01-01T05:00:00Z", "UTC")).toBe(2027);
  });

  it("returns null for an invalid instant or zone", () => {
    expect(eventYearOf("nope", "UTC")).toBeNull();
    expect(eventYearOf("2026-01-01T00:00:00Z", "Mars/Olympus")).toBeNull();
  });
});

describe("createEventInputSchema", () => {
  const dated = {
    title: "Viaje a Ciudad de México",
    startsAt: "2026-11-20T10:00:00-06:00",
    endsAt: "2026-11-22T18:00:00-06:00"
  };

  it("applies defaults and derives nothing it does not need", () => {
    expect(createEventInputSchema.parse(dated)).toEqual({
      ...dated,
      summary: null,
      details: null,
      timezone: "America/Merida",
      locationText: null,
      visibility: "members",
      publish: false,
      participantUserIds: []
    });
  });

  it("requires a year when undated and accepts it", () => {
    expect(createEventInputSchema.safeParse({ ...dated, title: "\u200B\u200B" }).success).toBe(false);
    expect(createEventInputSchema.parse({ title: "Posada", year: 2026 }).year).toBe(2026);
  });

  it("rejects a year that does not match the start date in the timezone", () => {
    expect(createEventInputSchema.safeParse({ ...dated, year: 2025 }).success).toBe(false);
    expect(createEventInputSchema.safeParse({ ...dated, year: 2026 }).success).toBe(true);
    const newYearsEve = { title: "Año Nuevo", startsAt: "2027-01-01T05:00:00Z", endsAt: "2027-01-01T08:00:00Z" };
    expect(createEventInputSchema.safeParse({ ...newYearsEve, year: 2026 }).success).toBe(true);
    expect(createEventInputSchema.safeParse({ ...newYearsEve, year: 2027 }).success).toBe(false);
  });

  it("requires both dates or neither, end after start", () => {
    expect(createEventInputSchema.safeParse({ ...dated, title: "\u200B\u200B" }).success).toBe(false);
    expect(createEventInputSchema.safeParse({ ...dated, endsAt: dated.startsAt }).success).toBe(false);
  });

  it("is strict and bounds every text", () => {
    expect(createEventInputSchema.safeParse({ ...dated, status: "published" }).success).toBe(false);
    expect(createEventInputSchema.safeParse({ ...dated, title: "x".repeat(121) }).success).toBe(false);
    expect(createEventInputSchema.safeParse({ ...dated, summary: "x".repeat(281) }).success).toBe(false);
    expect(createEventInputSchema.safeParse({ ...dated, details: "x".repeat(4001) }).success).toBe(false);
    expect(createEventInputSchema.safeParse({ ...dated, locationText: "x".repeat(161) }).success).toBe(false);
  });

  it("cleans text: strips bidi marks, keeps emoji ZWJ, blank optional text becomes null", () => {
    const parsed = createEventInputSchema.parse({
      ...dated,
      title: "  Fiesta \u202Efamiliar \u{1F468}\u200D\u{1F469}\u200D\u{1F467} ",
      summary: "   ",
      details: "Línea 1\r\nLínea 2",
      locationText: "\u200B"
    });
    expect(parsed.title).toBe("Fiesta familiar \u{1F468}\u200D\u{1F469}\u200D\u{1F467}");
    expect(parsed.summary).toBeNull();
    expect(parsed.details).toBe("Línea 1\nLínea 2");
    expect(parsed.locationText).toBeNull();
  });

  it("rejects multi-line titles and invisible-only titles", () => {
    expect(createEventInputSchema.safeParse({ ...dated, title: "Uno\nDos" }).success).toBe(false);
    expect(createEventInputSchema.safeParse({ ...dated, title: "\u200B\u200B" }).success).toBe(false);
    expect(createEventInputSchema.safeParse({ ...dated, summary: "Uno\nDos" }).success).toBe(false);
  });

  it("never accepts a slug from members; admins may type one (Security M1)", () => {
    expect(createEventInputSchema.safeParse({ ...dated, slug: "viaje-cdmx" }).success).toBe(false);
    expect(adminCreateEventInputSchema.parse({ ...dated, slug: " Viaje-CDMX " }).slug).toBe("viaje-cdmx");
    expect(adminCreateEventInputSchema.parse(dated)).not.toHaveProperty("slug");
    expect(adminCreateEventInputSchema.safeParse({ ...dated, slug: "a" }).success).toBe(false);
    // The admin schema keeps the member refines.
    expect(adminCreateEventInputSchema.safeParse({ title: "Posada" }).success).toBe(false);
  });

  it("dedupes nothing silently: repeated participants are rejected", () => {
    expect(createEventInputSchema.safeParse({ ...dated, participantUserIds: [userId, userId] }).success).toBe(false);
    expect(createEventInputSchema.parse({ ...dated, participantUserIds: [userId, otherUserId] }).participantUserIds).toHaveLength(2);
  });
});

describe("updateEventInputSchema", () => {
  it("never fills defaults and rejects an empty patch", () => {
    expect(updateEventInputSchema.parse({ title: "Nuevo título" })).toEqual({ title: "Nuevo título" });
    expect(updateEventInputSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a status and visibility change", () => {
    expect(updateEventInputSchema.parse({ status: "published", visibility: "participants" })).toEqual({
      status: "published",
      visibility: "participants"
    });
    expect(updateEventInputSchema.safeParse({ status: "archived" }).success).toBe(false);
  });

  it("allows a lone non-null date but not a lone null", () => {
    expect(updateEventInputSchema.safeParse({ startsAt: "2026-11-20T10:00:00-06:00" }).success).toBe(true);
    expect(updateEventInputSchema.safeParse({ startsAt: null }).success).toBe(false);
    expect(updateEventInputSchema.safeParse({ startsAt: null, endsAt: null, year: 2027 }).success).toBe(true);
  });

  it("is strict", () => {
    expect(updateEventInputSchema.safeParse({ firstPublishedAt: "2026-01-01T00:00:00Z" }).success).toBe(false);
  });

  it("accepts a slug only in the admin schema (Security M1)", () => {
    expect(updateEventInputSchema.safeParse({ slug: "otro-slug" }).success).toBe(false);
    expect(adminUpdateEventInputSchema.parse({ slug: "Otro-Slug" })).toEqual({ slug: "otro-slug" });
    expect(adminUpdateEventInputSchema.safeParse({}).success).toBe(false);
    expect(adminUpdateEventInputSchema.safeParse({ startsAt: null }).success).toBe(false);
  });
});

describe("eventDatesIssue", () => {
  const base = { timezone: "America/Merida" };

  it("accepts a dated row with a matching or unset year, and an undated row with a year", () => {
    const dates = { startsAt: "2026-11-20T10:00:00-06:00", endsAt: "2026-11-21T10:00:00-06:00" };
    expect(eventDatesIssue({ ...base, ...dates, year: 2026 })).toBeNull();
    expect(eventDatesIssue({ ...base, ...dates, year: null })).toBeNull();
    expect(eventDatesIssue({ ...base, startsAt: null, endsAt: null, year: 2019 })).toBeNull();
  });

  it("reports each broken rule on its field", () => {
    expect(eventDatesIssue({ ...base, startsAt: "2026-11-20T10:00:00Z", endsAt: null, year: 2026 })?.path).toBe("endsAt");
    expect(
      eventDatesIssue({ ...base, startsAt: "2026-11-20T10:00:00Z", endsAt: "2026-11-20T09:00:00Z", year: 2026 })?.path
    ).toBe("endsAt");
    expect(
      eventDatesIssue({ ...base, startsAt: "2026-11-20T10:00:00Z", endsAt: "2026-11-21T10:00:00Z", year: 2025 })?.path
    ).toBe("year");
    expect(eventDatesIssue({ ...base, startsAt: null, endsAt: null, year: null })?.path).toBe("year");
  });
});

describe("isPastEvent", () => {
  const now = new Date("2026-10-11T12:00:00Z");

  it("uses the end date when dated", () => {
    expect(isPastEvent({ year: 2026, endsAt: "2026-10-10T00:00:00Z", timezone: "UTC" }, now)).toBe(true);
    expect(isPastEvent({ year: 2026, endsAt: "2026-10-12T00:00:00Z", timezone: "UTC" }, now)).toBe(false);
  });

  it("uses the year in the event's timezone when undated", () => {
    expect(isPastEvent({ year: 2025, endsAt: null, timezone: "America/Merida" }, now)).toBe(true);
    expect(isPastEvent({ year: 2026, endsAt: null, timezone: "America/Merida" }, now)).toBe(false);
    // 03:00 UTC on Jan 1 is still Dec 31 in Mérida: a 2026 undated event is not over yet.
    expect(isPastEvent({ year: 2026, endsAt: null, timezone: "America/Merida" }, new Date("2027-01-01T03:00:00Z"))).toBe(false);
  });
});

describe("participants and albums inputs", () => {
  it("adds 1–50 distinct users as participants by default", () => {
    expect(addEventParticipantsInputSchema.parse({ userIds: [userId] })).toEqual({ userIds: [userId], role: "participant" });
    expect(addEventParticipantsInputSchema.safeParse({ userIds: [] }).success).toBe(false);
    expect(addEventParticipantsInputSchema.safeParse({ userIds: [userId, userId] }).success).toBe(false);
    expect(addEventParticipantsInputSchema.safeParse({ userIds: ["not-a-uuid"] }).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect(addEventParticipantsInputSchema.safeParse({ userIds: many }).success).toBe(false);
  });

  it("validates album titles and sort order", () => {
    expect(createEventAlbumInputSchema.parse({ title: "  Día 1 " })).toEqual({ title: "Día 1" });
    expect(createEventAlbumInputSchema.safeParse({ title: "x".repeat(81) }).success).toBe(false);
    expect(updateEventAlbumInputSchema.safeParse({}).success).toBe(false);
    expect(updateEventAlbumInputSchema.safeParse({ sortOrder: -1 }).success).toBe(false);
    expect(updateEventAlbumInputSchema.parse({ sortOrder: 3 })).toEqual({ sortOrder: 3 });
  });

  it("accepts an empty body for join and leave", () => {
    expect(emptyEventBodySchema.safeParse(null).success).toBe(true);
    expect(emptyEventBodySchema.safeParse(undefined).success).toBe(true);
    expect(emptyEventBodySchema.safeParse({}).success).toBe(true);
    expect(emptyEventBodySchema.safeParse({ userId }).success).toBe(false);
  });
});

describe("queries and params", () => {
  it("defaults the list to upcoming and coerces year and mine", () => {
    expect(eventListQuerySchema.parse({})).toEqual({ limit: 20, when: "upcoming" });
    expect(eventListQuerySchema.parse({ when: "past", year: "2025", mine: "true" })).toEqual({
      limit: 20,
      when: "past",
      year: 2025,
      mine: true
    });
    expect(eventListQuerySchema.safeParse({ when: "all" }).success).toBe(false);
  });

  it("validates the year/slug path", () => {
    expect(eventPathParamsSchema.parse({ year: "2026", slug: "carne-asada" })).toEqual({ year: 2026, slug: "carne-asada" });
    expect(eventPathParamsSchema.safeParse({ year: "2026", slug: "../x" }).success).toBe(false);
  });
});

describe("cover crop", () => {
  it("accepts an optional crop and nothing else", () => {
    expect(eventCoverConfirmBodySchema.parse({})).toEqual({});
    expect(eventCoverConfirmBodySchema.parse({ crop: { x: 0, y: 10, size: 1600 } })).toEqual({ crop: { x: 0, y: 10, size: 1600 } });
    expect(eventCoverConfirmBodySchema.safeParse({ crop: { x: 0, y: 0, size: 0 } }).success).toBe(false);
    expect(eventCoverConfirmBodySchema.safeParse({ uploadId: albumId }).success).toBe(false);
  });

  it("keeps a 16:9 box inside the image and preserves the framing", () => {
    expect(clampAspectCropRect({ x: 100, y: 50, size: 1600 }, 4000, 3000, EVENT_COVER_ASPECT)).toEqual({
      left: 100,
      top: 50,
      width: 1600,
      height: 900
    });
    // Shifted back inside rather than shrunk.
    expect(clampAspectCropRect({ x: 3900, y: 2900, size: 1600 }, 4000, 3000, EVENT_COVER_ASPECT)).toEqual({
      left: 2400,
      top: 2100,
      width: 1600,
      height: 900
    });
    // Too wide for a portrait image: capped by width.
    expect(clampAspectCropRect({ x: 0, y: 0, size: 30000 }, 1080, 1920, EVENT_COVER_ASPECT)).toEqual({
      left: 0,
      top: 0,
      width: 1080,
      height: 608
    });
    // Too tall for a panorama: capped by height × aspect.
    expect(clampAspectCropRect({ x: 0, y: 0, size: 30000 }, 8000, 900, EVENT_COVER_ASPECT)).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900
    });
  });

  it("never yields an empty or out-of-bounds region for tiny images", () => {
    const crop = clampAspectCropRect({ x: 5, y: 5, size: 1 }, 1, 1, EVENT_COVER_ASPECT);
    expect(crop).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  it("throws on invalid dimensions, aspect or a non-finite rect", () => {
    expect(() => clampAspectCropRect({ x: 0, y: 0, size: 10 }, 0, 10, EVENT_COVER_ASPECT)).toThrow(RangeError);
    expect(() => clampAspectCropRect({ x: 0, y: 0, size: 10 }, 10, 10, 0)).toThrow(RangeError);
    expect(() => clampAspectCropRect({ x: Number.NaN, y: 0, size: 10 }, 10, 10, EVENT_COVER_ASPECT)).toThrow(RangeError);
  });
});

describe("read models", () => {
  const participant = { displayName: "Ana", avatarUrl: null, role: "organizer", joinedAt: "2026-10-01T10:00:00Z", isSelf: false };
  const detail = {
    id: eventId,
    year: 2026,
    slug: "viaje-cdmx",
    title: "Viaje a CDMX",
    summary: null,
    startsAt: null,
    endsAt: null,
    timezone: "America/Merida",
    locationText: null,
    coverUrl: null,
    visibility: "participants",
    status: "published",
    participantCount: 1,
    viewerRole: "organizer",
    canManage: true,
    canJoin: false,
    hasChat: true,
    details: null,
    firstPublishedAt: "2026-10-01T10:00:00Z",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    participants: [participant],
    albums: [
      { id: albumId, eventId, title: "Fotos", sortOrder: 0, mediaCount: 0, coverThumbUrl: null, createdAt: "2026-10-01T10:00:00Z" }
    ],
    chatRoomId: null,
    canDelete: false,
    canLeave: false
  };

  it("parses a detail and strips unknown fields (PII guard)", () => {
    const parsed = eventDetailSchema.parse({ ...detail, createdByEmail: "ana@example.test" });
    expect(parsed).not.toHaveProperty("createdByEmail");
    expect(parsed.participants[0]).not.toHaveProperty("userId");
  });

  it("keeps a participant's userId only when present, and never accepts null for it", () => {
    expect(eventParticipantSchema.parse({ ...participant, userId }).userId).toBe(userId);
    expect(eventParticipantSchema.safeParse({ ...participant, userId: null }).success).toBe(false);
    expect(eventParticipantSchema.parse({ ...participant, email: "x@example.test" })).not.toHaveProperty("email");
  });
});

describe("chat and media compatibility", () => {
  const room = {
    id: eventId,
    kind: "global",
    cuencadaId: null,
    year: null,
    title: "Chat familiar",
    unreadCount: 0,
    lastMessageAt: null,
    lastReadMessageId: null,
    lastMessage: null
  };

  it("parses an old room without `event`, and an event room with it", () => {
    expect(chatRoomSchema.parse(room)).toEqual(room);
    const eventRoom = { ...room, kind: ChatRoomKind.Event, event: { id: eventId, year: 2026, slug: "viaje-cdmx", title: "Viaje" } };
    expect(chatRoomSchema.parse(eventRoom).event?.slug).toBe("viaje-cdmx");
    expect(chatRoomSchema.parse({ ...room, event: null }).event).toBeNull();
  });

  it("parses the room_removed frame", () => {
    expect(wsServerMessageSchema.parse({ type: "room_removed", roomId: eventId })).toEqual({ type: "room_removed", roomId: eventId });
  });

  const item = {
    id: eventId,
    cuencadaId: albumId,
    year: 2026,
    kind: "image",
    mimeType: "image/jpeg",
    thumbUrl: null,
    displayUrl: null,
    width: null,
    height: null,
    durationSeconds: null,
    caption: null,
    uploaderName: null,
    isMine: false,
    canEdit: false,
    canDelete: false,
    uploadStatus: "ready",
    moderationStatus: "approved",
    createdAt: "2026-10-01T10:00:00Z"
  };

  it("parses old edition media and new album media", () => {
    expect(mediaItemSchema.parse(item)).toEqual(item);
    const albumItem = {
      ...item,
      cuencadaId: null,
      year: null,
      album: { id: albumId, title: "Fotos", eventId },
      event: { id: eventId, year: 2026, slug: "viaje-cdmx", title: "Viaje" }
    };
    expect(mediaItemSchema.parse(albumItem)).toEqual(albumItem);
  });
});

describe("audit and error codes", () => {
  it("adds the event audit actions in the dotted pattern", () => {
    const eventActions = Object.values(AuditAction).filter((action) => action.startsWith("event."));
    expect(eventActions).toEqual(
      expect.arrayContaining([
        "event.created",
        "event.updated",
        "event.published",
        "event.hidden",
        "event.deleted",
        "event.participant_added",
        "event.participant_removed",
        "event.joined",
        "event.left",
        "event.album_created",
        "event.album_updated",
        "event.album_deleted",
        "event.cover_updated",
        "event.cover_removed",
        "event.admin_viewed"
      ])
    );
    for (const action of eventActions) expect(action).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    expect(AuditEntityType.Event).toBe("event");
  });

  it("keeps detail codes within the open channel's 64 characters", () => {
    for (const code of Object.values(EventIssueCode)) expect(code.length).toBeLessThanOrEqual(64);
    expect(Object.values(EventIssueCode)).toEqual(
      expect.arrayContaining([
        "EVENT_NOT_FOUND",
        "EVENT_NOT_PARTICIPANT",
        "EVENT_JOIN_NOT_ALLOWED",
        "EVENT_SLUG_TAKEN",
        "EVENT_ALBUM_NOT_EMPTY",
        "EVENT_DELETE_NOT_ALLOWED"
      ])
    );
  });

  it("is reachable from the package barrel", () => {
    expect(barrel.createEventInputSchema).toBe(createEventInputSchema);
    expect(barrel.eventRefSchema).toBeDefined();
    expect(barrel.slugifyEventTitle).toBe(slugifyEventTitle);
  });
});
