/**
 * The authorization matrix (WP-2.3) [SEC]: one entry per registered route,
 * keyed `METHOD /url`, with its expected guard classification and a builder
 * for a minimal **valid** request (real fixtures in the worker database), so
 * an allowed principal reaches the handler and gets a 2xx, and a denied one
 * proves the denial comes from the guard, not from a 400/404.
 *
 * `inventory.test.ts` fails when a registered route is missing here (or an
 * entry has no route, or the classification differs), so a new route cannot
 * ship unclassified. `authz-matrix.test.ts` exercises every entry with every
 * principal.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { App } from "../../app.js";
import {
  avatarUploads,
  chatMessages,
  chatReadStates,
  chatRooms,
  cuencadaRsvps,
  invites,
  MagicLinkPurpose,
  mediaItems,
  mediaReports,
  people,
  profiles,
  sessions,
  users
} from "../../db/schema/index.js";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";
import { createEmailToken } from "../../modules/auth/emailTokens.js";
import { CSRF_HEADERS, refreshCookie, TEST_REFRESH_COOKIE } from "../../../test/helpers/auth.js";
import { insertEditionRoom, insertGlobalRoom, insertMessage } from "../../../test/helpers/chat.js";
import {
  insertAnnouncement,
  insertCuencada,
  insertDailyMessage,
  insertItineraryItem,
  insertLocation
} from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, bearerFor, createSession, createUser, type TestUser } from "../../../test/helpers/factories.js";
import type { FakeMailer, FakeStorage } from "../../../test/helpers/fakes.js";
import { insertParentOf, insertPerson } from "../../../test/helpers/family.js";
import { insertMedia, makePng } from "../../../test/helpers/media.js";

/** Who calls a route in the matrix. */
export const Principal = {
  Anonymous: "anonymous",
  Member: "member",
  Unverified: "unverified",
  PendingPasswordChange: "pending",
  Disabled: "disabled",
  RevokedSession: "revoked",
  Admin: "admin"
} as const;
export type Principal = (typeof Principal)[keyof typeof Principal];

/** Every principal, in report order. */
export const PRINCIPALS: readonly Principal[] = Object.values(Principal);

/** Guard levels as declared in `config.auth`. */
export type AuthLevel = "public" | "user" | "admin" | "cookie";

/** An expected outcome: a status class or an exact status, optionally with the error code. */
export type Expectation = "2xx" | { status: number; code?: string };

/** A caller identity with a live session (the anonymous principal never sends its headers). */
export interface Actor {
  user: TestUser;
  sessionId: string;
  auth: AuthInjectOptions;
}

/** Everything a request builder can use. One context per principal per route. */
export interface MatrixContext {
  app: App;
  storage: FakeStorage;
  mailer: FakeMailer;
  principal: Principal;
  /** The caller (for anonymous: a member whose credentials are not sent). */
  actor: Actor;
  /** Another verified member: the owner of resources in IDOR checks. */
  other: Actor;
  /** A fresh, unique edition year for this test (2101..2200). */
  nextYear(): number;
  /** Next unique client IP (rate limits are per IP). */
  nextIp(): string;
}

/** What a builder returns: the concrete URL plus body/headers/cookies. */
export interface BuiltRequest {
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  /** Do not send the actor's bearer token even for authenticated principals (cookie routes). */
  noBearer?: boolean;
}

/** One matrix entry. */
export interface RouteSpec {
  method: string;
  /** Route pattern exactly as registered (`/api/media/:id`). */
  url: string;
  auth: AuthLevel;
  requireVerifiedEmail?: true;
  allowPendingPasswordChange?: true;
  /** Owner-scoped/self-scoped resource (documented in routes.md). */
  owner?: string;
  /** Free-text note for the inventory. */
  note?: string;
  /** Not exercised through `inject()` (the WebSocket upgrade has its own tests). */
  websocket?: true;
  /** Build a minimal valid request for `ctx.actor`. */
  build(ctx: MatrixContext): Promise<BuiltRequest>;
  /** Expected outcome for allowed principals (default `"2xx"`). */
  success?: Expectation;
  /** Per-principal overrides of the derived expectation. */
  expect?: Partial<Record<Principal, Expectation>>;
  /**
   * Extra probes run as a verified member: IDOR on `ctx.other`'s resources,
   * hidden rooms, own-item rules and mass assignment. When the request
   * returns `state`, it is read before and after the call and must not change.
   */
  probes?: Probe[];
}

/** A request whose effect is checked by re-reading the rows it must not touch. */
export interface ProbeRequest extends BuiltRequest {
  /** Reads the protected state; compared before and after the request. */
  state?: () => Promise<unknown>;
}

/** One extra probe (see {@link RouteSpec.probes}). */
export interface Probe {
  /** Short label for routes.md and failure messages. */
  label: string;
  /** `"idor"` probes fill the "Other member (IDOR)" column of routes.md. */
  kind: "idor" | "rule" | "mass-assignment";
  build(ctx: MatrixContext): Promise<ProbeRequest>;
  expect: Expectation;
}

/* -------------------------------------------------------------------------- */
/* Fixture helpers                                                             */
/* -------------------------------------------------------------------------- */

/** A published, upcoming edition (RSVPs open). */
async function upcoming(ctx: MatrixContext): Promise<{ id: string; year: number }> {
  const row = await insertCuencada({ year: ctx.nextYear() });
  return { id: row.id, year: row.year };
}

/** A tiny real PNG, cached. */
let pngCache: Buffer | null = null;
async function png(): Promise<Buffer> {
  pngCache ??= await makePng(8, 8);
  return pngCache;
}

/** Real login through the route, returning the refresh token (cookie routes). */
async function refreshTokenFor(ctx: MatrixContext, user: TestUser): Promise<{ token: string; sessionId: string }> {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: ctx.nextIp(),
    payload: { email: user.email, password: user.password }
  });
  const cookie = refreshCookie(response);
  if (response.statusCode !== 200 || cookie === undefined) {
    throw new Error(`refreshTokenFor: login failed with ${response.statusCode}`);
  }
  // The login created the user's only session besides the actor's own.
  const [session] = await getTestDb()
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, user.id), ne(sessions.id, ctx.actor.sessionId)));
  if (session === undefined) throw new Error("refreshTokenFor: no session");
  return { token: cookie.value, sessionId: session.id };
}

/**
 * A refresh cookie for the actor in the state its principal describes: the
 * session is revoked for `revoked`, the user disabled for `disabled`, and
 * anonymous callers send no cookie.
 */
async function cookieRequest(ctx: MatrixContext): Promise<BuiltRequest> {
  if (ctx.principal === Principal.Anonymous) return { url: "", headers: { ...CSRF_HEADERS }, noBearer: true };
  // The disabled actor was created disabled; log in while active, then disable again.
  await getTestDb().update(users).set({ status: "active" }).where(eq(users.id, ctx.actor.user.id));
  const { token, sessionId } = await refreshTokenFor(ctx, ctx.actor.user);
  if (ctx.principal === Principal.RevokedSession) {
    await getTestDb().update(sessions).set({ revokedAt: new Date(), revokedReason: "logout" }).where(eq(sessions.id, sessionId));
  }
  if (ctx.principal === Principal.Disabled) {
    await getTestDb().update(users).set({ status: "disabled" }).where(eq(users.id, ctx.actor.user.id));
  }
  return { url: "", headers: { ...CSRF_HEADERS }, cookies: { [TEST_REFRESH_COOKIE]: token }, noBearer: true };
}

/** An email token (magic link / reset / verify) for `user`. */
async function emailToken(user: TestUser, purpose: MagicLinkPurpose): Promise<string> {
  const created = await getTestDb().transaction((tx) =>
    createEmailToken(tx, { userId: user.id, email: user.email, purpose, requestIp: "203.0.113.1", now: new Date() })
  );
  return created.token;
}

/** A pending open member invite; returns the raw token. */
async function openInvite(): Promise<string> {
  const token = createOpaqueToken();
  await getTestDb()
    .insert(invites)
    .values({ tokenHash: hashToken(token), email: null, maxUses: 5, expiresAt: new Date(Date.now() + 86_400_000) });
  return token;
}

/** A pending, uploaded (in FakeStorage) gallery item owned by `owner`. */
async function pendingUpload(ctx: MatrixContext, owner: Actor): Promise<string> {
  const edition = await upcoming(ctx);
  const body = await png();
  const id = randomUUID();
  const key = `cuencadas/${edition.year}/originals/${id}.png`;
  await insertMedia({
    id,
    cuencadaId: edition.id,
    uploadedByUserId: owner.user.id,
    objectKey: key,
    thumbKey: null,
    displayKey: null,
    mimeType: "image/png",
    byteSize: body.byteLength,
    width: null,
    height: null,
    uploadStatus: "pending_upload",
    uploadExpiresAt: new Date(Date.now() + 300_000)
  });
  await ctx.storage.simulateUpload(key, body, "image/png");
  return id;
}

/** A ready gallery item owned by `owner` (`moderationStatus` defaults to approved). */
async function readyMedia(ctx: MatrixContext, owner: Actor | null, moderationStatus: "approved" | "hidden" = "approved"): Promise<string> {
  const edition = await upcoming(ctx);
  const row = await insertMedia({
    cuencadaId: edition.id,
    uploadedByUserId: owner?.user.id ?? null,
    moderationStatus
  });
  return row.id;
}

/** An uploaded avatar intent owned by `owner`. */
async function avatarIntent(ctx: MatrixContext, owner: Actor): Promise<string> {
  const body = await png();
  const id = randomUUID();
  const key = `avatars/${owner.user.id}/${id}.png`;
  await getTestDb()
    .insert(avatarUploads)
    .values({ id, userId: owner.user.id, objectKey: key, mimeType: "image/png", byteSize: body.byteLength, expiresAt: new Date(Date.now() + 300_000) });
  await ctx.storage.simulateUpload(key, body, "image/png");
  return id;
}

/** The global chat room (one per database). */
async function globalRoom(): Promise<{ id: string }> {
  const [existing] = await getTestDb().select({ id: chatRooms.id }).from(chatRooms).where(eq(chatRooms.kind, "global")).limit(1);
  return existing ?? insertGlobalRoom();
}

/** A chat message in the global room sent by `owner`. */
async function chatMessage(owner: Actor): Promise<{ roomId: string; messageId: string }> {
  const room = await globalRoom();
  const message = await insertMessage({ roomId: room.id, senderUserId: owner.user.id });
  return { roomId: room.id, messageId: message.id };
}

/** A member who is listed in the directory with all contact fields visible. */
async function listedMember(): Promise<TestUser> {
  return createUser({
    emailVerified: true,
    profile: { listedInDirectory: true, showEmail: true, showPhone: true, showCity: true, phone: "5550000000", city: "Mérida" }
  });
}

const json = (url: string, payload?: unknown): BuiltRequest => (payload === undefined ? { url } : { url, payload });

const NOT_FOUND: Expectation = { status: 404, code: "NOT_FOUND" };

/** A gallery item of `owner` in any upload/moderation state. */
async function mediaIn(
  ctx: MatrixContext,
  owner: Actor,
  state: Pick<typeof mediaItems.$inferInsert, "uploadStatus" | "moderationStatus">
): Promise<string> {
  const edition = await upcoming(ctx);
  const row = await insertMedia({ cuencadaId: edition.id, uploadedByUserId: owner.user.id, caption: "Leyenda original", ...state });
  return row.id;
}

/** The full media row (compared before/after a probe). */
function mediaState(id: string): () => Promise<unknown> {
  return async () => getTestDb().select().from(mediaItems).where(eq(mediaItems.id, id));
}

/** A message by `sender` in a hidden room (the room of a draft edition). */
async function hiddenRoomMessage(ctx: MatrixContext, sender: Actor): Promise<{ roomId: string; messageId: string }> {
  const draft = await insertCuencada({ year: ctx.nextYear(), isPublished: false });
  const room = await insertEditionRoom(draft.id, draft.year);
  const message = await insertMessage({ roomId: room.id, senderUserId: sender.user.id });
  return { roomId: room.id, messageId: message.id };
}

/**
 * Mass assignment on the self-edit of the caller's tree node: keys outside
 * nickname/familyBranch/birthYear (name, account link, death data) must have
 * no effect on the caller's node nor on anyone else's.
 */
function familyMassAssignment(url: string): Probe {
  return {
    label: "extra keys (fullName/userId/deceased/deathYear/id)",
    kind: "mass-assignment",
    build: async (ctx) => {
      const own = await insertPerson({ userId: ctx.actor.user.id, fullName: "Nombre Original" });
      const theirs = await insertPerson({ userId: ctx.other.user.id, fullName: "Nombre Ajeno" });
      return {
        ...json(url, {
          nickname: "Peque",
          fullName: "Nombre Cambiado",
          userId: ctx.other.user.id,
          deceased: true,
          deathYear: 2000,
          id: theirs.id
        }),
        state: async () =>
          getTestDb()
            .select({ id: people.id, fullName: people.fullName, userId: people.userId, deceased: people.deceased, deathYear: people.deathYear })
            .from(people)
            .where(inArray(people.id, [own.id, theirs.id]))
            .orderBy(people.fullName)
      };
    },
    expect: "2xx"
  };
}

/** The chat message row (compared before/after a probe). */
function messageState(id: string): () => Promise<unknown> {
  return async () => getTestDb().select().from(chatMessages).where(eq(chatMessages.id, id));
}

/* -------------------------------------------------------------------------- */
/* The matrix                                                                  */
/* -------------------------------------------------------------------------- */

/** Every route of the API. Order follows `app.ts` module registration. */
export const ROUTE_MATRIX: readonly RouteSpec[] = [
  // ---------------------------------------------------------------- platform
  {
    method: "OPTIONS",
    url: "*",
    auth: "user",
    note: "@fastify/cors preflight; answered by the CORS onRequest hook before the guard",
    build: async () => ({
      url: "/api/me",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
      noBearer: true
    }),
    expect: Object.fromEntries(PRINCIPALS.map((p) => [p, "2xx"])) as Record<Principal, Expectation>
  },
  { method: "GET", url: "/health", auth: "public", build: async () => json("/health") },
  { method: "GET", url: "/health/ready", auth: "public", build: async () => json("/health/ready") },

  // ---------------------------------------------------------------- auth: sessions
  {
    method: "POST",
    url: "/api/auth/login",
    auth: "public",
    build: async (ctx) => json("/api/auth/login", { email: ctx.actor.user.email, password: ctx.actor.user.password }),
    expect: { disabled: { status: 401, code: "INVALID_CREDENTIALS" } }
  },
  {
    method: "POST",
    url: "/api/auth/refresh",
    auth: "cookie",
    owner: "refresh cookie of the caller's session",
    build: async (ctx) => ({ ...(await cookieRequest(ctx)), url: "/api/auth/refresh" })
  },
  {
    method: "POST",
    url: "/api/auth/logout",
    auth: "cookie",
    owner: "refresh cookie of the caller's session",
    note: "a disabled user's cookie may still log out (it only revokes that session)",
    build: async (ctx) => ({ ...(await cookieRequest(ctx)), url: "/api/auth/logout" }),
    expect: { disabled: "2xx" }
  },
  { method: "POST", url: "/api/auth/logout-all", auth: "user", build: async () => json("/api/auth/logout-all") },
  { method: "GET", url: "/api/me", auth: "user", allowPendingPasswordChange: true, build: async () => json("/api/me") },
  { method: "GET", url: "/api/auth/sessions", auth: "user", build: async () => json("/api/auth/sessions") },
  {
    method: "DELETE",
    url: "/api/auth/sessions/:id",
    auth: "user",
    owner: "own sessions only (404 for anyone else's)",
    build: async (ctx) => {
      const extra = await createSession(ctx.actor.user.id);
      return json(`/api/auth/sessions/${extra.id}`);
    },
    probes: [
      {
        label: "another member's session",
        kind: "idor",
        build: async (ctx) => ({
          ...json(`/api/auth/sessions/${ctx.other.sessionId}`),
          state: async () => getTestDb().select().from(sessions).where(eq(sessions.id, ctx.other.sessionId))
        }),
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "POST",
    url: "/api/auth/sessions/revoke-others",
    auth: "user",
    build: async () => json("/api/auth/sessions/revoke-others")
  },
  {
    method: "POST",
    url: "/api/auth/change-password",
    auth: "user",
    allowPendingPasswordChange: true,
    build: async (ctx) =>
      json("/api/auth/change-password", { currentPassword: ctx.actor.user.password, newPassword: "otra-frase-larga-y-segura-2026" })
  },
  // ---------------------------------------------------------------- auth: email tokens
  {
    method: "POST",
    url: "/api/auth/password-reset/request",
    auth: "public",
    build: async (ctx) => json("/api/auth/password-reset/request", { email: ctx.actor.user.email })
  },
  {
    method: "POST",
    url: "/api/auth/password-reset/confirm",
    auth: "public",
    build: async (ctx) =>
      json("/api/auth/password-reset/confirm", {
        token: await emailToken(ctx.actor.user, MagicLinkPurpose.PasswordReset),
        newPassword: "otra-frase-larga-y-segura-2026"
      }),
    expect: { disabled: { status: 400, code: "TOKEN_INVALID" } }
  },
  {
    method: "POST",
    url: "/api/auth/magic-link/request",
    auth: "public",
    build: async (ctx) => json("/api/auth/magic-link/request", { email: ctx.actor.user.email })
  },
  {
    method: "POST",
    url: "/api/auth/magic-link/consume",
    auth: "public",
    build: async (ctx) =>
      json("/api/auth/magic-link/consume", { token: await emailToken(ctx.actor.user, MagicLinkPurpose.Login) }),
    expect: { disabled: { status: 400, code: "TOKEN_INVALID" } }
  },
  {
    method: "POST",
    url: "/api/auth/email/verify-request",
    auth: "user",
    build: async () => json("/api/auth/email/verify-request")
  },
  {
    method: "POST",
    url: "/api/auth/email/verify",
    auth: "public",
    build: async (ctx) =>
      json("/api/auth/email/verify", { token: await emailToken(ctx.actor.user, MagicLinkPurpose.EmailVerify) }),
    expect: { disabled: { status: 400, code: "TOKEN_INVALID" } }
  },

  // ---------------------------------------------------------------- invites
  {
    method: "POST",
    url: "/api/invites/inspect",
    auth: "public",
    build: async () => json("/api/invites/inspect", { token: await openInvite() })
  },
  {
    method: "POST",
    url: "/api/invites/accept",
    auth: "public",
    build: async () =>
      json("/api/invites/accept", {
        token: await openInvite(),
        email: `invitado-${randomUUID()}@example.test`,
        displayName: "Persona Invitada",
        password: "una-frase-larga-y-segura-2026"
      })
  },
  { method: "GET", url: "/api/admin/invites", auth: "admin", build: async () => json("/api/admin/invites") },
  {
    method: "POST",
    url: "/api/admin/invites",
    auth: "admin",
    build: async () => json("/api/admin/invites", { email: null, sendEmail: false, maxUses: 2 })
  },
  {
    method: "POST",
    url: "/api/admin/invites/:id/revoke",
    auth: "admin",
    build: async () => {
      const [row] = await getTestDb()
        .insert(invites)
        .values({ tokenHash: hashToken(createOpaqueToken()), email: null, expiresAt: new Date(Date.now() + 86_400_000) })
        .returning({ id: invites.id });
      return json(`/api/admin/invites/${row?.id ?? randomUUID()}/revoke`);
    }
  },
  {
    method: "POST",
    url: "/api/admin/invites/:id/resend",
    auth: "admin",
    build: async () => {
      const [row] = await getTestDb()
        .insert(invites)
        .values({
          tokenHash: hashToken(createOpaqueToken()),
          email: `invitada-${randomUUID()}@example.test`,
          expiresAt: new Date(Date.now() + 86_400_000),
          lastSentAt: new Date(Date.now() - 3_600_000)
        })
        .returning({ id: invites.id });
      return json(`/api/admin/invites/${row?.id ?? randomUUID()}/resend`);
    }
  },

  // ---------------------------------------------------------------- profile
  { method: "GET", url: "/api/profile/me", auth: "user", build: async () => json("/api/profile/me") },
  {
    method: "PATCH",
    url: "/api/profile/me",
    auth: "user",
    build: async () => json("/api/profile/me", { city: "Mérida" })
  },
  {
    method: "POST",
    url: "/api/profile/me/avatar/uploads",
    auth: "user",
    build: async () => json("/api/profile/me/avatar/uploads", { mimeType: "image/png", byteSize: 1000 })
  },
  {
    method: "POST",
    url: "/api/profile/me/avatar/confirm",
    auth: "user",
    owner: "own upload intents only (404 for another user's uploadId)",
    build: async (ctx) => json("/api/profile/me/avatar/confirm", { uploadId: await avatarIntent(ctx, ctx.actor) }),
    probes: [
      {
        label: "another member's upload intent",
        kind: "idor",
        build: async (ctx) => {
          const uploadId = await avatarIntent(ctx, ctx.other);
          return {
            ...json("/api/profile/me/avatar/confirm", { uploadId }),
            state: async () => ({
              upload: await getTestDb().select().from(avatarUploads).where(eq(avatarUploads.id, uploadId)),
              profiles: await getTestDb()
                .select({ userId: profiles.userId, avatarKey: profiles.avatarKey })
                .from(profiles)
                .where(eq(profiles.userId, ctx.other.user.id))
            })
          };
        },
        expect: NOT_FOUND
      }
    ]
  },
  { method: "DELETE", url: "/api/profile/me/avatar", auth: "user", build: async () => json("/api/profile/me/avatar") },

  // ---------------------------------------------------------------- directory
  {
    method: "GET",
    url: "/api/directory",
    auth: "user",
    requireVerifiedEmail: true,
    build: async () => json("/api/directory")
  },
  {
    method: "GET",
    url: "/api/directory/:id",
    auth: "user",
    requireVerifiedEmail: true,
    owner: "listed members only (404 for unlisted)",
    build: async () => json(`/api/directory/${(await listedMember()).id}`),
    probes: [
      {
        label: "unlisted member",
        kind: "idor",
        build: async () => {
          const hidden = await createUser({ emailVerified: true, profile: { listedInDirectory: false } });
          return json(`/api/directory/${hidden.id}`);
        },
        expect: NOT_FOUND
      }
    ]
  },

  // ---------------------------------------------------------------- cuencadas (public + member)
  { method: "GET", url: "/api/cuencadas", auth: "public", build: async () => json("/api/cuencadas") },
  { method: "GET", url: "/api/cuencadas/home", auth: "public", build: async () => json("/api/cuencadas/home") },
  {
    method: "GET",
    url: "/api/cuencadas/:year",
    auth: "public",
    build: async (ctx) => json(`/api/cuencadas/${(await upcoming(ctx)).year}`)
  },
  {
    method: "GET",
    url: "/api/cuencadas/:year/members",
    auth: "user",
    requireVerifiedEmail: true,
    build: async (ctx) => json(`/api/cuencadas/${(await upcoming(ctx)).year}/members`)
  },

  // ---------------------------------------------------------------- cuencadas (admin)
  { method: "GET", url: "/api/admin/cuencadas", auth: "admin", build: async () => json("/api/admin/cuencadas") },
  {
    method: "POST",
    url: "/api/admin/cuencadas",
    auth: "admin",
    build: async (ctx) => {
      const year = ctx.nextYear();
      return json("/api/admin/cuencadas", {
        year,
        title: `Cuencada ${year}`,
        startsAt: `${year}-09-12T00:00:00-06:00`,
        endsAt: `${year}-09-17T23:59:59-06:00`,
        city: "Mérida",
        state: "Yucatán",
        description: "Reunión de prueba."
      });
    }
  },
  {
    method: "GET",
    url: "/api/admin/cuencadas/:id",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/cuencadas/${(await upcoming(ctx)).id}`)
  },
  {
    method: "PATCH",
    url: "/api/admin/cuencadas/:id",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/cuencadas/${(await upcoming(ctx)).id}`, { title: "Nuevo título" })
  },
  {
    method: "DELETE",
    url: "/api/admin/cuencadas/:id",
    auth: "admin",
    build: async (ctx) => {
      const draft = await insertCuencada({ year: ctx.nextYear(), isPublished: false });
      return json(`/api/admin/cuencadas/${draft.id}`);
    }
  },
  {
    method: "POST",
    url: "/api/admin/cuencadas/:id/itinerary",
    auth: "admin",
    build: async (ctx) => {
      const edition = await upcoming(ctx);
      return json(`/api/admin/cuencadas/${edition.id}/itinerary`, { date: `${edition.year}-09-13`, title: "Comida" });
    }
  },
  {
    method: "PUT",
    url: "/api/admin/cuencadas/:id/itinerary/order",
    auth: "admin",
    build: async (ctx) => {
      const edition = await upcoming(ctx);
      const item = await insertItineraryItem(edition.id, { date: `${edition.year}-09-13` });
      return json(`/api/admin/cuencadas/${edition.id}/itinerary/order`, { ids: [item.id] });
    }
  },
  {
    method: "PATCH",
    url: "/api/admin/itinerary/:id",
    auth: "admin",
    build: async (ctx) => {
      const edition = await upcoming(ctx);
      const item = await insertItineraryItem(edition.id, { date: `${edition.year}-09-13` });
      return json(`/api/admin/itinerary/${item.id}`, { title: "Cena" });
    }
  },
  {
    method: "DELETE",
    url: "/api/admin/itinerary/:id",
    auth: "admin",
    build: async (ctx) => {
      const edition = await upcoming(ctx);
      const item = await insertItineraryItem(edition.id, { date: `${edition.year}-09-13` });
      return json(`/api/admin/itinerary/${item.id}`);
    }
  },
  {
    method: "POST",
    url: "/api/admin/cuencadas/:id/locations",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/cuencadas/${(await upcoming(ctx)).id}/locations`, { name: "Hotel Central" })
  },
  {
    method: "PUT",
    url: "/api/admin/cuencadas/:id/locations/order",
    auth: "admin",
    build: async (ctx) => {
      const edition = await upcoming(ctx);
      const location = await insertLocation(edition.id);
      return json(`/api/admin/cuencadas/${edition.id}/locations/order`, { ids: [location.id] });
    }
  },
  {
    method: "PATCH",
    url: "/api/admin/locations/:id",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/locations/${(await insertLocation((await upcoming(ctx)).id)).id}`, { name: "Salón" })
  },
  {
    method: "DELETE",
    url: "/api/admin/locations/:id",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/locations/${(await insertLocation((await upcoming(ctx)).id)).id}`)
  },
  {
    method: "GET",
    url: "/api/admin/cuencadas/:id/daily-messages",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/cuencadas/${(await upcoming(ctx)).id}/daily-messages`)
  },
  {
    method: "PUT",
    url: "/api/admin/cuencadas/:id/daily-messages/:date",
    auth: "admin",
    build: async (ctx) => {
      const edition = await upcoming(ctx);
      return json(`/api/admin/cuencadas/${edition.id}/daily-messages/${edition.year}-09-13`, { message: "Hola" });
    }
  },
  {
    method: "DELETE",
    url: "/api/admin/cuencadas/:id/daily-messages/:date",
    auth: "admin",
    build: async (ctx) => {
      const edition = await upcoming(ctx);
      await insertDailyMessage(edition.id, `${edition.year}-09-13`, "Hola");
      return json(`/api/admin/cuencadas/${edition.id}/daily-messages/${edition.year}-09-13`);
    }
  },
  {
    method: "POST",
    url: "/api/admin/cuencadas/:id/daily-messages/import",
    auth: "admin",
    build: async (ctx) => {
      const edition = await upcoming(ctx);
      return json(`/api/admin/cuencadas/${edition.id}/daily-messages/import`, { text: `${edition.year}-09-13|Hola` });
    }
  },

  // ---------------------------------------------------------------- RSVP
  {
    method: "GET",
    url: "/api/cuencadas/:year/rsvp/me",
    auth: "user",
    owner: "self-scoped (the caller's RSVP; no id in the path)",
    build: async (ctx) => json(`/api/cuencadas/${(await upcoming(ctx)).year}/rsvp/me`)
  },
  {
    method: "PUT",
    url: "/api/cuencadas/:year/rsvp/me",
    auth: "user",
    owner: "self-scoped",
    build: async (ctx) => json(`/api/cuencadas/${(await upcoming(ctx)).year}/rsvp/me`, { status: "yes" }),
    probes: [
      {
        label: "RSVP body naming another member (userId/cuencadaId/createdByUserId)",
        kind: "mass-assignment",
        build: async (ctx) => {
          const edition = await upcoming(ctx);
          const other = await upcoming(ctx);
          return {
            ...json(`/api/cuencadas/${edition.year}/rsvp/me`, {
              status: "yes",
              userId: ctx.other.user.id,
              cuencadaId: other.id,
              id: randomUUID()
            }),
            // Nothing may be written for the other member or the other edition.
            state: async () => ({
              otherMember: await getTestDb().select().from(cuencadaRsvps).where(eq(cuencadaRsvps.userId, ctx.other.user.id)),
              otherEdition: await getTestDb().select().from(cuencadaRsvps).where(eq(cuencadaRsvps.cuencadaId, other.id))
            })
          };
        },
        expect: "2xx"
      }
    ]
  },
  {
    method: "GET",
    url: "/api/cuencadas/:year/rsvp/summary",
    auth: "user",
    note: "counts only, no names",
    build: async (ctx) => json(`/api/cuencadas/${(await upcoming(ctx)).year}/rsvp/summary`)
  },
  {
    method: "GET",
    url: "/api/cuencadas/:year/attendees",
    auth: "user",
    requireVerifiedEmail: true,
    build: async (ctx) => json(`/api/cuencadas/${(await upcoming(ctx)).year}/attendees`)
  },
  {
    method: "GET",
    url: "/api/admin/cuencadas/:id/rsvps",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/cuencadas/${(await upcoming(ctx)).id}/rsvps`)
  },
  {
    method: "GET",
    url: "/api/admin/cuencadas/:id/rsvps.csv",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/cuencadas/${(await upcoming(ctx)).id}/rsvps.csv`)
  },
  {
    method: "GET",
    url: "/api/admin/cuencadas/:id/attendance",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/cuencadas/${(await upcoming(ctx)).id}/attendance`)
  },
  {
    method: "POST",
    url: "/api/admin/cuencadas/:id/attendance",
    auth: "admin",
    build: async (ctx) => {
      const edition = await upcoming(ctx);
      const person = await insertPerson();
      return json(`/api/admin/cuencadas/${edition.id}/attendance`, { add: [person.id] });
    }
  },
  {
    method: "PUT",
    url: "/api/admin/cuencadas/:id/attendance",
    auth: "admin",
    build: async (ctx) => {
      const edition = await upcoming(ctx);
      const person = await insertPerson();
      return json(`/api/admin/cuencadas/${edition.id}/attendance`, { personIds: [person.id] });
    }
  },

  // ---------------------------------------------------------------- media
  {
    method: "POST",
    url: "/api/cuencadas/:year/media/uploads",
    auth: "user",
    requireVerifiedEmail: true,
    build: async (ctx) =>
      json(`/api/cuencadas/${(await upcoming(ctx)).year}/media/uploads`, {
        fileName: "foto.png",
        mimeType: "image/png",
        byteSize: 1000
      })
  },
  {
    method: "POST",
    url: "/api/media/:id/confirm",
    auth: "user",
    requireVerifiedEmail: true,
    owner: "uploader only (404 for others)",
    build: async (ctx) => json(`/api/media/${await pendingUpload(ctx, ctx.actor)}/confirm`),
    probes: [
      {
        label: "another member's pending upload",
        kind: "idor",
        build: async (ctx) => {
          const id = await pendingUpload(ctx, ctx.other);
          return { ...json(`/api/media/${id}/confirm`), state: mediaState(id) };
        },
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "GET",
    url: "/api/cuencadas/:year/media",
    auth: "user",
    requireVerifiedEmail: true,
    note: "presigned GET URLs (1 h); verified members only (WP-2.3 L2 owner decision)",
    build: async (ctx) => json(`/api/cuencadas/${(await upcoming(ctx)).year}/media`)
  },
  {
    method: "GET",
    url: "/api/media/:id",
    auth: "user",
    requireVerifiedEmail: true,
    owner: "hidden/pending items only for the uploader and admins (404 otherwise)",
    build: async (ctx) => json(`/api/media/${await readyMedia(ctx, ctx.other)}`),
    probes: [
      {
        label: "another member's hidden item",
        kind: "idor",
        build: async (ctx) => json(`/api/media/${await mediaIn(ctx, ctx.other, { uploadStatus: "ready", moderationStatus: "hidden" })}`),
        expect: NOT_FOUND
      },
      {
        label: "another member's item pending review",
        kind: "idor",
        build: async (ctx) =>
          json(`/api/media/${await mediaIn(ctx, ctx.other, { uploadStatus: "ready", moderationStatus: "pending_review" })}`),
        expect: NOT_FOUND
      },
      ...(["pending_upload", "processing", "failed"] as const).map(
        (uploadStatus): Probe => ({
          label: `another member's ${uploadStatus} item`,
          kind: "idor",
          build: async (ctx) => json(`/api/media/${await mediaIn(ctx, ctx.other, { uploadStatus, moderationStatus: "approved" })}`),
          expect: NOT_FOUND
        })
      )
    ]
  },
  {
    method: "PATCH",
    url: "/api/media/:id",
    auth: "user",
    requireVerifiedEmail: true,
    owner: "uploader or admin (404 for other members)",
    build: async (ctx) => json(`/api/media/${await readyMedia(ctx, ctx.actor)}`, { caption: "Nueva" }),
    probes: [
      ...(["ready", "pending_upload", "processing", "failed"] as const).map(
        (uploadStatus): Probe => ({
          label: `another member's ${uploadStatus} item`,
          kind: "idor",
          build: async (ctx) => {
            const id = await mediaIn(ctx, ctx.other, { uploadStatus, moderationStatus: "approved" });
            return { ...json(`/api/media/${id}`, { caption: "Mía" }), state: mediaState(id) };
          },
          expect: NOT_FOUND
        })
      )
    ]
  },
  {
    method: "DELETE",
    url: "/api/media/:id",
    auth: "user",
    requireVerifiedEmail: true,
    owner: "uploader or admin (404 for other members)",
    build: async (ctx) => json(`/api/media/${await readyMedia(ctx, ctx.actor)}`),
    probes: [
      ...(["ready", "pending_upload", "processing", "failed"] as const).map(
        (uploadStatus): Probe => ({
          label: `another member's ${uploadStatus} item`,
          kind: "idor",
          build: async (ctx) => {
            const id = await mediaIn(ctx, ctx.other, { uploadStatus, moderationStatus: "approved" });
            return { ...json(`/api/media/${id}`), state: mediaState(id) };
          },
          expect: NOT_FOUND
        })
      )
    ]
  },
  {
    method: "POST",
    url: "/api/media/:id/report",
    auth: "user",
    requireVerifiedEmail: true,
    owner: "any member except the uploader (403 on own items)",
    build: async (ctx) => json(`/api/media/${await readyMedia(ctx, ctx.other)}/report`, { reason: "other" }),
    probes: [
      {
        label: "report own item",
        kind: "rule",
        build: async (ctx) => {
          const id = await readyMedia(ctx, ctx.actor);
          return {
            ...json(`/api/media/${id}/report`, { reason: "other" }),
            state: async () => getTestDb().select().from(mediaReports).where(eq(mediaReports.mediaId, id))
          };
        },
        expect: { status: 403, code: "FORBIDDEN" }
      },
      {
        label: "another member's hidden item",
        kind: "idor",
        build: async (ctx) => {
          const id = await mediaIn(ctx, ctx.other, { uploadStatus: "ready", moderationStatus: "hidden" });
          return {
            ...json(`/api/media/${id}/report`, { reason: "other" }),
            state: async () => getTestDb().select().from(mediaReports).where(eq(mediaReports.mediaId, id))
          };
        },
        expect: NOT_FOUND
      }
    ]
  },
  { method: "GET", url: "/api/admin/media", auth: "admin", build: async () => json("/api/admin/media") },
  {
    method: "GET",
    url: "/api/admin/media/:id/reports",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/media/${await readyMedia(ctx, ctx.other)}/reports`)
  },
  {
    method: "POST",
    url: "/api/admin/media/:id/moderate",
    auth: "admin",
    build: async (ctx) => json(`/api/admin/media/${await readyMedia(ctx, ctx.other)}/moderate`, { action: "hide" })
  },

  // ---------------------------------------------------------------- family
  {
    method: "GET",
    url: "/api/family/people",
    auth: "user",
    requireVerifiedEmail: true,
    build: async () => json("/api/family/people")
  },
  {
    method: "GET",
    url: "/api/family/people/:id",
    auth: "user",
    requireVerifiedEmail: true,
    build: async () => json(`/api/family/people/${(await insertPerson()).id}`)
  },
  {
    method: "GET",
    url: "/api/family/tree",
    auth: "user",
    requireVerifiedEmail: true,
    build: async (ctx) => {
      await insertPerson({ userId: ctx.actor.user.id });
      return json("/api/family/tree");
    }
  },
  {
    method: "PATCH",
    url: "/api/family/me",
    auth: "user",
    requireVerifiedEmail: true,
    owner: "self-scoped (the caller's linked person)",
    build: async (ctx) => {
      await insertPerson({ userId: ctx.actor.user.id });
      return json("/api/family/me", { nickname: "Peque" });
    },
    probes: [familyMassAssignment("/api/family/me")]
  },
  {
    method: "PATCH",
    url: "/api/family/people/me",
    auth: "user",
    requireVerifiedEmail: true,
    owner: "self-scoped alias of /api/family/me",
    build: async (ctx) => {
      await insertPerson({ userId: ctx.actor.user.id });
      return json("/api/family/people/me", { nickname: "Peque" });
    },
    probes: [familyMassAssignment("/api/family/people/me")]
  },
  {
    method: "POST",
    url: "/api/admin/people",
    auth: "admin",
    build: async () => json("/api/admin/people", { fullName: "Persona Nueva" })
  },
  {
    method: "PATCH",
    url: "/api/admin/people/:id",
    auth: "admin",
    build: async () => json(`/api/admin/people/${(await insertPerson()).id}`, { nickname: "Tito" })
  },
  {
    method: "DELETE",
    url: "/api/admin/people/:id",
    auth: "admin",
    build: async () => json(`/api/admin/people/${(await insertPerson()).id}`)
  },
  {
    method: "POST",
    url: "/api/admin/relationships",
    auth: "admin",
    build: async () => {
      const parent = await insertPerson();
      const child = await insertPerson();
      return json("/api/admin/relationships", { kind: "parent_of", fromPersonId: parent.id, toPersonId: child.id });
    }
  },
  {
    method: "DELETE",
    url: "/api/admin/relationships/:id",
    auth: "admin",
    build: async () => {
      const edge = await insertParentOf((await insertPerson()).id, (await insertPerson()).id);
      return json(`/api/admin/relationships/${edge.id}`);
    }
  },

  // ---------------------------------------------------------------- chat
  {
    method: "GET",
    url: "/api/chat/rooms",
    auth: "user",
    requireVerifiedEmail: true,
    build: async () => {
      await globalRoom();
      return json("/api/chat/rooms");
    }
  },
  {
    method: "GET",
    url: "/api/chat/rooms/:id/messages",
    auth: "user",
    requireVerifiedEmail: true,
    build: async (ctx) => json(`/api/chat/rooms/${(await chatMessage(ctx.other)).roomId}/messages`),
    probes: [
      {
        label: "history of a hidden room",
        kind: "rule",
        build: async (ctx) => json(`/api/chat/rooms/${(await hiddenRoomMessage(ctx, ctx.other)).roomId}/messages`),
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "POST",
    url: "/api/chat/rooms/:id/read",
    auth: "user",
    requireVerifiedEmail: true,
    build: async (ctx) => {
      const { roomId, messageId } = await chatMessage(ctx.other);
      return json(`/api/chat/rooms/${roomId}/read`, { messageId });
    },
    probes: [
      {
        label: "read state in a hidden room",
        kind: "rule",
        build: async (ctx) => {
          const { roomId, messageId } = await hiddenRoomMessage(ctx, ctx.other);
          return {
            ...json(`/api/chat/rooms/${roomId}/read`, { messageId }),
            state: async () => getTestDb().select().from(chatReadStates).where(eq(chatReadStates.roomId, roomId))
          };
        },
        expect: NOT_FOUND
      },
      {
        label: "message of another room",
        kind: "rule",
        build: async (ctx) => {
          const { messageId } = await hiddenRoomMessage(ctx, ctx.other);
          const room = await globalRoom();
          return {
            ...json(`/api/chat/rooms/${room.id}/read`, { messageId }),
            state: async () => getTestDb().select().from(chatReadStates).where(eq(chatReadStates.roomId, room.id))
          };
        },
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "DELETE",
    url: "/api/chat/messages/:id",
    auth: "user",
    requireVerifiedEmail: true,
    owner: "sender or admin (404 for other members)",
    build: async (ctx) => json(`/api/chat/messages/${(await chatMessage(ctx.actor)).messageId}`),
    probes: [
      {
        label: "another member's message",
        kind: "idor",
        build: async (ctx) => {
          const { messageId } = await chatMessage(ctx.other);
          return { ...json(`/api/chat/messages/${messageId}`), state: messageState(messageId) };
        },
        expect: NOT_FOUND
      },
      {
        label: "own message in a hidden room",
        kind: "rule",
        build: async (ctx) => {
          const { messageId } = await hiddenRoomMessage(ctx, ctx.actor);
          return { ...json(`/api/chat/messages/${messageId}`), state: messageState(messageId) };
        },
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "POST",
    url: "/api/chat/ticket",
    auth: "user",
    requireVerifiedEmail: true,
    build: async () => json("/api/chat/ticket")
  },
  {
    method: "GET",
    url: "/api/chat/ws",
    auth: "public",
    websocket: true,
    note: "authenticated by the single-use ticket + Origin check in the handler (see the WebSocket tests)",
    build: async () => json("/api/chat/ws")
  },

  // ---------------------------------------------------------------- announcements
  {
    method: "GET",
    url: "/api/announcements",
    auth: "user",
    build: async () => {
      await insertAnnouncement({ visibility: "members" });
      return json("/api/announcements");
    }
  },
  { method: "GET", url: "/api/admin/announcements", auth: "admin", build: async () => json("/api/admin/announcements") },
  {
    method: "POST",
    url: "/api/admin/announcements",
    auth: "admin",
    build: async () => json("/api/admin/announcements", { title: "Aviso", body: "Texto.", cuencadaId: null })
  },
  {
    method: "PATCH",
    url: "/api/admin/announcements/:id",
    auth: "admin",
    build: async () => json(`/api/admin/announcements/${(await insertAnnouncement()).id}`, { title: "Otro" })
  },
  {
    method: "DELETE",
    url: "/api/admin/announcements/:id",
    auth: "admin",
    build: async () => json(`/api/admin/announcements/${(await insertAnnouncement()).id}`)
  },

  // ---------------------------------------------------------------- admin console
  { method: "GET", url: "/api/admin/users", auth: "admin", build: async () => json("/api/admin/users") },
  {
    method: "PATCH",
    url: "/api/admin/users/:id",
    auth: "admin",
    note: "403 on the caller's own account",
    build: async (ctx) => json(`/api/admin/users/${ctx.other.user.id}`, { status: "disabled" })
  },
  {
    method: "POST",
    url: "/api/admin/users/:id/revoke-sessions",
    auth: "admin",
    note: "403 on the caller's own account",
    build: async (ctx) => json(`/api/admin/users/${ctx.other.user.id}/revoke-sessions`)
  },
  {
    method: "POST",
    url: "/api/admin/users/:id/force-password-reset",
    auth: "admin",
    note: "403 on the caller's own account",
    build: async (ctx) => json(`/api/admin/users/${ctx.other.user.id}/force-password-reset`)
  },
  {
    method: "POST",
    url: "/api/admin/users/:id/verify-email",
    auth: "admin",
    note: "403 on the caller's own account",
    build: async () => {
      const target = await createUser({ emailVerified: false });
      return json(`/api/admin/users/${target.id}/verify-email`);
    }
  },
  { method: "GET", url: "/api/admin/audit-logs", auth: "admin", build: async () => json("/api/admin/audit-logs") },
  { method: "GET", url: "/api/admin/summary", auth: "admin", build: async () => json("/api/admin/summary") }
];

/** `METHOD url` key used by the inventory. */
export function routeKey(route: { method: string; url: string }): string {
  return `${route.method} ${route.url}`;
}

/**
 * The expected outcome of `principal` calling `spec` (guard semantics of
 * `plugins/auth.ts`, then the spec's overrides).
 */
export function expectationFor(spec: RouteSpec, principal: Principal): Expectation {
  const override = spec.expect?.[principal];
  if (override !== undefined) return override;
  const success = spec.success ?? "2xx";
  const unauthenticated = { status: 401, code: "UNAUTHENTICATED" };
  switch (spec.auth) {
    case "public":
      return success;
    case "cookie":
      return principal === Principal.Anonymous || principal === Principal.Disabled || principal === Principal.RevokedSession
        ? unauthenticated
        : success;
    case "user":
    case "admin": {
      if (principal === Principal.Anonymous || principal === Principal.Disabled || principal === Principal.RevokedSession) {
        return unauthenticated;
      }
      if (principal === Principal.PendingPasswordChange && spec.allowPendingPasswordChange !== true) {
        return { status: 403, code: "PASSWORD_CHANGE_REQUIRED" };
      }
      if (spec.auth === "admin" && principal !== Principal.Admin) return { status: 403, code: "FORBIDDEN" };
      if (principal === Principal.Unverified && spec.requireVerifiedEmail === true) {
        return { status: 403, code: "EMAIL_UNVERIFIED" };
      }
      return success;
    }
  }
}

/**
 * Create the actor for `principal`: a fresh user + session + bearer token in
 * the state the principal describes.
 */
export async function createActor(principal: Principal): Promise<Actor> {
  const user = await createUser({
    emailVerified: principal !== Principal.Unverified,
    role: principal === Principal.Admin ? "admin" : "member",
    mustChangePassword: principal === Principal.PendingPasswordChange
  });
  const session = await createSession(user.id, { revoked: principal === Principal.RevokedSession });
  const auth = await bearerFor(user, session);
  if (principal === Principal.Disabled) {
    // Disabled after the token was issued: the old token must stop working at once.
    await getTestDb().update(users).set({ status: "disabled" }).where(eq(users.id, user.id));
  }
  return { user, sessionId: session.id, auth };
}
