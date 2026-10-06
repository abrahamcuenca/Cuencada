/**
 * Admin console test fixtures (fictional people only) and contract-validated
 * MSW handlers over a tiny in-memory store. Every response is `parse`d by the
 * contract schema, so a drifting fixture fails loudly.
 */
import {
  type AdminInviteListItem,
  type AdminSummary,
  type AdminUserListItem,
  type AuditLogEntry,
  adminForcePasswordResetResultSchema,
  adminInviteCreatedSchema,
  adminInviteCreateInputSchema,
  adminInviteListItemSchema,
  adminSummarySchema,
  adminUserListItemSchema,
  adminUserPatchInputSchema,
  auditLogEntrySchema,
  type CurrentUser,
  pageSchema
} from "@cuencada/types";
import { type HttpHandler, HttpResponse, http } from "msw";
import { apiUrl, errorBody, makeUser } from "../../../../test/auth";

/** Stable ids. */
export const IDS = {
  admin: "0b9c2f7e-1d2a-4c3b-8e4f-5a6b7c8d9e01",
  lucia: "0b9c2f7e-1d2a-4c3b-8e4f-5a6b7c8d9e02",
  mateo: "0b9c2f7e-1d2a-4c3b-8e4f-5a6b7c8d9e03",
  inviteBound: "1c0d3e8f-2e3b-4d4c-9f50-6b7c8d9e0f01",
  inviteOpen: "1c0d3e8f-2e3b-4d4c-9f50-6b7c8d9e0f02",
  inviteNew: "1c0d3e8f-2e3b-4d4c-9f50-6b7c8d9e0f03",
  edition: "2d1e4f90-3f4c-4e5d-a061-7c8d9e0f1a01"
} as const;

/** The signed-in admin (fictional). */
export const ADMIN_USER: CurrentUser = makeUser({
  id: IDS.admin,
  email: "elena.duarte@example.com",
  displayName: "Elena Duarte Páez",
  role: "admin"
});

/** A stored XSS attempt: must render as text. */
export const XSS_STRING = '<img src=x onerror="alert(1)">';

/** The one-time URL returned for an open invite. */
export const ONE_TIME_URL = "https://cuencada.example.com/invitacion#t=dGVzdC10b2tlbi1zb2xvLXVuYS12ZXo";

function user(overrides: Partial<AdminUserListItem> & Pick<AdminUserListItem, "id" | "email" | "displayName">): AdminUserListItem {
  return adminUserListItemSchema.parse({
    role: "member",
    status: "active",
    mustChangePassword: false,
    emailVerified: true,
    personId: null,
    lastLoginAt: "2026-10-01T15:30:00.000Z",
    activeSessionCount: 2,
    createdAt: "2026-01-10T12:00:00.000Z",
    ...overrides
  });
}

/**
 * `count` fictional unverified members ("Primo N Ejemplo"), for paging tests.
 *
 * @param count - How many.
 * @returns Admin list rows.
 */
export function makeUnverifiedUsers(count: number): AdminUserListItem[] {
  return Array.from({ length: count }, (_, index) =>
    user({
      id: `0b9c2f7e-1d2a-4c3b-8e4f-${String(index + 100).padStart(12, "0")}`,
      email: `primo${index + 1}@example.com`,
      displayName: `Primo ${index + 1} Ejemplo`,
      emailVerified: false
    })
  );
}

/** Users, newest first. */
export function makeUsers(): AdminUserListItem[] {
  return [
    user({ id: IDS.lucia, email: "lucia.ramirez@example.com", displayName: "Lucía Ramírez Soto", emailVerified: false, activeSessionCount: 3 }),
    user({ id: IDS.mateo, email: "mateo.ortega@example.com", displayName: "Mateo Ortega Vidal", status: "disabled", activeSessionCount: 0 }),
    user({ id: IDS.admin, email: ADMIN_USER.email, displayName: ADMIN_USER.displayName, role: "admin", activeSessionCount: 1 })
  ];
}

/** Invites, newest first. */
export function makeInvites(): AdminInviteListItem[] {
  return [
    adminInviteListItemSchema.parse({
      id: IDS.inviteBound,
      email: "tomas.villa@example.com",
      role: "member",
      status: "pending",
      maxUses: 1,
      useCount: 0,
      expiresAt: "2026-10-12T18:00:00.000Z",
      createdAt: "2026-10-05T18:00:00.000Z",
      createdByName: ADMIN_USER.displayName,
      personId: null,
      note: null,
      lastSentAt: "2026-10-05T18:00:00.000Z"
    }),
    adminInviteListItemSchema.parse({
      id: IDS.inviteOpen,
      email: null,
      role: "member",
      status: "accepted",
      maxUses: 10,
      useCount: 10,
      expiresAt: "2026-09-20T18:00:00.000Z",
      createdAt: "2026-09-10T18:00:00.000Z",
      createdByName: ADMIN_USER.displayName,
      personId: null,
      note: "Grupo de primos",
      lastSentAt: null
    })
  ];
}

/** Dashboard counters. */
export function makeSummary(overrides: Partial<AdminSummary> = {}): AdminSummary {
  return adminSummarySchema.parse({
    usersActive: 42,
    usersDisabled: 3,
    usersUnverified: 5,
    activeAdmins: 2,
    invitesPending: 7,
    mediaPendingReview: 4,
    mediaReported: 1,
    upcomingEdition: {
      cuencadaId: IDS.edition,
      year: 2027,
      title: "Cuencada 2027",
      startsAt: "2027-09-12T14:00:00.000Z",
      rsvpYes: 30,
      rsvpMaybe: 6,
      rsvpNo: 2,
      rsvpGuests: 9
    },
    ...overrides
  });
}

/** Builds `count` audit entries, newest first; the first carries the XSS string in its metadata. */
export function makeAuditEntries(count: number): AuditLogEntry[] {
  return Array.from({ length: count }, (_, index) =>
    auditLogEntrySchema.parse({
      id: `3e2f5a01-4a5d-4f6e-b172-${String(index).padStart(12, "0")}`,
      actorUserId: index === 1 ? null : IDS.admin,
      actorName: index === 1 ? null : ADMIN_USER.displayName,
      action: index === 0 ? "user.disabled" : "invite.created",
      entityType: index === 0 ? "user" : "invite",
      entityId: index === 0 ? IDS.mateo : IDS.inviteBound,
      metadata:
        index === 0
          ? {
              fields: ["status"],
              revokedSessions: 2,
              burnedEmailLinks: 0,
              note: XSS_STRING,
              adminAlertRecipients: 2,
              adminAlertExempt: true,
              adminAlertLimitNotice: true,
              adminAlertSkipped: true
            }
          : index === 2
            ? { adminAlertExempt: "true", adminAlertSkipped: 1 }
            : { role: "member", sendEmail: true },
      ip: "203.0.113.7",
      createdAt: new Date(Date.UTC(2026, 9, 6, 18, 0) - index * 60_000).toISOString()
    })
  );
}

/** A recorded request. */
export interface LoggedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/** In-memory admin backend. */
export interface AdminDb {
  users: AdminUserListItem[];
  invites: AdminInviteListItem[];
  audit: AuditLogEntry[];
  summary: AdminSummary;
  log: LoggedRequest[];
  /** Force the next force-password-reset to report `emailQueued: false`. */
  emailQueued: boolean;
}

/** @returns A fresh store. */
export function makeAdminDb(): AdminDb {
  return { users: makeUsers(), invites: makeInvites(), audit: makeAuditEntries(30), summary: makeSummary(), log: [], emailQueued: true };
}

async function record(db: AdminDb, request: Request): Promise<LoggedRequest> {
  const url = new URL(request.url);
  const text = request.method === "GET" ? "" : await request.text();
  const entry: LoggedRequest = {
    method: request.method,
    path: url.pathname.replace(/^.*\/api/, ""),
    query: Object.fromEntries(url.searchParams),
    body: text === "" ? undefined : JSON.parse(text)
  };
  db.log.push(entry);
  return entry;
}

/** Keyset paging over an array: the cursor is the index of the next item. */
function paginate<TItem>(items: TItem[], query: Record<string, string>): { items: TItem[]; nextCursor: string | null } {
  const limit = Number(query.limit ?? "25");
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  const next = start + limit;
  return { items: items.slice(start, next), nextCursor: next < items.length ? String(next) : null };
}

function findUser(db: AdminDb, id: string | readonly string[] | undefined): AdminUserListItem | undefined {
  return db.users.find((candidate) => candidate.id === id);
}

function replaceUser(db: AdminDb, next: AdminUserListItem): AdminUserListItem {
  db.users = db.users.map((candidate) => (candidate.id === next.id ? next : candidate));
  return adminUserListItemSchema.parse(next);
}

/**
 * @param db - The store the handlers read and write.
 * @returns MSW handlers for every admin endpoint the console calls.
 */
export function adminHandlers(db: AdminDb): HttpHandler[] {
  const userPage = pageSchema(adminUserListItemSchema);
  const invitePage = pageSchema(adminInviteListItemSchema);
  const auditPage = pageSchema(auditLogEntrySchema);
  return [
    http.get(apiUrl("/admin/summary"), async ({ request }) => {
      await record(db, request);
      return HttpResponse.json(adminSummarySchema.parse(db.summary));
    }),

    http.get(apiUrl("/admin/invites"), async ({ request }) => {
      const { query } = await record(db, request);
      const items = query.status === undefined ? db.invites : db.invites.filter((invite) => invite.status === query.status);
      return HttpResponse.json(invitePage.parse(paginate(items, query)));
    }),
    http.post(apiUrl("/admin/invites"), async ({ request }) => {
      const { body } = await record(db, request);
      const input = adminInviteCreateInputSchema.safeParse(body);
      if (!input.success) return HttpResponse.json(errorBody("VALIDATION", "Datos inválidos."), { status: 400 });
      const invite = adminInviteListItemSchema.parse({
        id: IDS.inviteNew,
        email: input.data.email,
        role: input.data.role,
        status: "pending",
        maxUses: input.data.maxUses,
        useCount: 0,
        expiresAt: "2026-10-13T18:00:00.000Z",
        createdAt: "2026-10-06T18:00:00.000Z",
        createdByName: ADMIN_USER.displayName,
        personId: null,
        note: input.data.note,
        lastSentAt: input.data.sendEmail ? "2026-10-06T18:00:00.000Z" : null
      });
      db.invites = [invite, ...db.invites];
      return HttpResponse.json(adminInviteCreatedSchema.parse({ invite, inviteUrl: input.data.sendEmail ? null : ONE_TIME_URL }), { status: 201 });
    }),
    http.post(apiUrl("/admin/invites/:id/revoke"), async ({ request, params }) => {
      await record(db, request);
      const invite = db.invites.find((candidate) => candidate.id === params.id);
      if (invite === undefined) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      const next = { ...invite, status: "revoked" as const };
      db.invites = db.invites.map((candidate) => (candidate.id === next.id ? next : candidate));
      return HttpResponse.json(adminInviteListItemSchema.parse(next));
    }),
    http.post(apiUrl("/admin/invites/:id/resend"), async ({ request, params }) => {
      await record(db, request);
      const invite = db.invites.find((candidate) => candidate.id === params.id);
      if (invite === undefined) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      const next = { ...invite, lastSentAt: "2026-10-06T19:00:00.000Z" };
      db.invites = db.invites.map((candidate) => (candidate.id === next.id ? next : candidate));
      return HttpResponse.json(adminInviteListItemSchema.parse(next));
    }),

    http.get(apiUrl("/admin/users"), async ({ request }) => {
      const { query } = await record(db, request);
      const q = query.q?.toLowerCase();
      const items = db.users.filter(
        (candidate) =>
          (q === undefined || candidate.displayName.toLowerCase().includes(q) || candidate.email.includes(q)) &&
          (query.role === undefined || candidate.role === query.role) &&
          (query.status === undefined || candidate.status === query.status) &&
          (query.emailVerified === undefined || String(candidate.emailVerified) === query.emailVerified)
      );
      return HttpResponse.json(userPage.parse(paginate(items, query)));
    }),
    http.patch(apiUrl("/admin/users/:id"), async ({ request, params }) => {
      const { body } = await record(db, request);
      const patch = adminUserPatchInputSchema.safeParse(body);
      const target = findUser(db, params.id);
      if (!patch.success) return HttpResponse.json(errorBody("VALIDATION"), { status: 400 });
      if (target === undefined) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      if (target.id === IDS.admin) {
        return HttpResponse.json(errorBody("FORBIDDEN", "No puedes cambiar tu propio rol ni desactivar tu propia cuenta."), { status: 403 });
      }
      const next: AdminUserListItem = {
        ...target,
        role: patch.data.role ?? target.role,
        status: patch.data.status ?? target.status,
        mustChangePassword: patch.data.mustChangePassword ?? target.mustChangePassword,
        activeSessionCount: patch.data.status === "disabled" ? 0 : target.activeSessionCount
      };
      return HttpResponse.json(replaceUser(db, next));
    }),
    http.post(apiUrl("/admin/users/:id/revoke-sessions"), async ({ request, params }) => {
      await record(db, request);
      const target = findUser(db, params.id);
      if (target === undefined) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      replaceUser(db, { ...target, activeSessionCount: 0 });
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(apiUrl("/admin/users/:id/force-password-reset"), async ({ request, params }) => {
      await record(db, request);
      const target = findUser(db, params.id);
      if (target === undefined) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      const next = replaceUser(db, { ...target, mustChangePassword: true, activeSessionCount: 0 });
      return HttpResponse.json(adminForcePasswordResetResultSchema.parse({ user: next, emailQueued: db.emailQueued }));
    }),
    http.post(apiUrl("/admin/users/:id/verify-email"), async ({ request, params }) => {
      await record(db, request);
      const target = findUser(db, params.id);
      if (target === undefined) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      return HttpResponse.json(replaceUser(db, { ...target, emailVerified: true }));
    }),

    http.get(apiUrl("/admin/audit-logs"), async ({ request }) => {
      const { query } = await record(db, request);
      const items = db.audit.filter(
        (entry) =>
          (query.action === undefined || entry.action === query.action) &&
          (query.entityType === undefined || entry.entityType === query.entityType) &&
          (query.actorUserId === undefined || entry.actorUserId === query.actorUserId) &&
          (query.from === undefined || entry.createdAt >= query.from) &&
          (query.to === undefined || entry.createdAt <= query.to)
      );
      return HttpResponse.json(auditPage.parse(paginate(items, query)));
    })
  ];
}

/**
 * @param db - The store.
 * @returns The non-GET requests, in order.
 */
export function writes(db: AdminDb): LoggedRequest[] {
  return db.log.filter((entry) => entry.method !== "GET");
}
