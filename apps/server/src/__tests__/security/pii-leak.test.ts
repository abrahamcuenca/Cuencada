/**
 * PII leakage (WP-2.3) [SEC]: the serialized JSON of every member-facing
 * read (directory, family, attendees, chat, media, profile, cuencadas) and of
 * the admin console never contains another person's hidden contact data,
 * hidden-flag fields, emails/phones of others, password or token hashes, IPs,
 * object keys, bucket names or presigned PUT URLs.
 *
 * Storage is the real `S3Storage` (presigning is offline), so presigned GET
 * URLs look exactly like production ones and can be told apart from PUTs.
 *
 * Hardening (PR #35 review N4): phones are matched on normalized digits, JWTs,
 * raw S3 keys and opaque tokens have patterns, the actual planted secrets
 * (access/refresh tokens, magic-link and invite tokens) are searched verbatim,
 * the unlisted member is checked by name, a deleted chat message is planted,
 * and the chat WebSocket frames are scanned too.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../app.js";
import { eq } from "drizzle-orm";
import { cuencadaAttendance, cuencadas, MagicLinkPurpose, people, personRelationships, profiles } from "../../db/schema/index.js";
import { systemClock } from "../../lib/clock.js";
import { S3Storage } from "../../lib/storage/s3.js";
import { createEmailToken } from "../../modules/auth/emailTokens.js";
import { mailQueue } from "../../modules/auth/mailQueue.js";
import { pushNotifications, recordNotification } from "../../modules/notifications/notify.js";
import { createTestApp, createTestConfig } from "../../../test/helpers/app.js";
import { linkToken, refreshCookie } from "../../../test/helpers/auth.js";
import { type ChatTestClient, connectMember, frameOf, insertGlobalRoom, insertMessage } from "../../../test/helpers/chat.js";
import { insertCuencada } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, bearerFor, createSession, createUser, type TestUser } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import { insertPerson } from "../../../test/helpers/family.js";
import { addParticipant, insertAlbumMedia, insertEvent } from "../../../test/helpers/events.js";
import { insertMedia } from "../../../test/helpers/media.js";

const BUCKET = "w23-pii-bucket";
const S3_CONFIG = {
  S3_ENDPOINT: "https://us-east-1.linodeobjects.com",
  S3_REGION: "us-east-1",
  S3_BUCKET: BUCKET,
  S3_ACCESS_KEY_ID: "AKIAW23FAKEFAKEFAKE",
  S3_SECRET_ACCESS_KEY: "w23-fake-secret-key-not-real",
  S3_PUBLIC_BASE_URL: ""
};
const YEAR = 2099;
/** Planted identifiers of the member who hides everything. */
const HIDDEN = {
  /** Stored formatted; matched on digits so any reformatting is still caught. */
  phone: "+52 (555) 777-0123",
  phoneDigits: "5557770123",
  city: "Ciudad-Oculta-W23",
  ip: "198.51.100.23",
  userAgent: "W23-Secret-Agent/1.0",
  rsvpNote: "nota-privada-w23",
  deletedChatBody: "cuerpo-borrado-w23",
  /** A living person's private life data (WP-4.1): only self, admins and the qualifying circle. */
  birthplace: "Lugar-Privado-W41",
  birthDate: "1977-11-23"
};
/**
 * WP-4.4: social contacts planted on the hidden member with every switch off,
 * and on the unlisted and disabled members with every switch **on**. None may
 * surface in a member-facing body (matched verbatim, and WhatsApp on digits).
 */
const HIDDEN_CONTACTS = {
  whatsapp: "+12025550199",
  instagram: "oculta.w44",
  facebook: "oculta.w44.fb",
  tiktok: "oculta_w44",
  linkedin: "oculta-w44",
  github: "oculta-w44-gh",
  website: "https://oculta-w44.example.com/"
};
const UNLISTED_CONTACTS = { instagram: "nolistada.w44", whatsapp: "+12025550188", website: "https://nolistada-w44.example.com/" };
const DISABLED_CONTACTS = { instagram: "baja.w44", whatsapp: "+12025550177", website: "https://baja-w44.example.com/" };
const ALL_SWITCHES_ON = {
  showEmail: true,
  showPhone: true,
  contactVisibility: { whatsapp: true, instagram: true, facebook: true, tiktok: true, linkedin: true, github: true, website: true }
};
/** Planted contact strings that must never reach a member-facing body. */
const PLANTED_CONTACT_STRINGS = [
  ...Object.values(HIDDEN_CONTACTS).map((value) => value.replace(/^\+/, "")),
  ...Object.values(UNLISTED_CONTACTS).map((value) => value.replace(/^\+/, "")),
  ...Object.values(DISABLED_CONTACTS).map((value) => value.replace(/^\+/, "")),
  "oculta-w44.example.com",
  "nolistada-w44.example.com",
  "baja-w44.example.com"
];
const UNLISTED_NAME = "Persona No Listada";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const ARGON2 = /\$argon2/i;
const SHA256_HEX = /\b[a-f0-9]{64}\b/i;
const PRESIGNED_PUT = /x-id=PutObject|X-Fake-Signature=put/i;
const SIGNED_STORAGE_URL = /linodeobjects\.com\/[^"]*X-Amz-Signature/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
/** Raw object keys (outside presigned URLs, which are masked first). */
const S3_KEY = /(?:cuencadas\/\d{4}\/(?:originals|thumbs|display)\/|avatars\/[0-9a-f-]{8,}\/|people\/[0-9a-f-]{8,}\/|events\/[0-9a-f-]{8,}\/)/;
/** Opaque tokens are 32 random bytes in base64url (43 chars). */
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Keys whose values are opaque by design (pagination cursors). */
const CURSOR_KEYS = new Set(["nextCursor", "nextBefore", "cursor"]);
/** Keys whose values may be presigned GET URLs. */
const SIGNED_URL_KEYS = new Set(["thumbUrl", "displayUrl", "avatarUrl", "photoUrl", "coverUrl", "coverThumbUrl"]);
/** Keys that must never be serialized to non-admins. */
const FORBIDDEN_KEYS = [
  "passwordHash",
  "tokenHash",
  "objectKey",
  "thumbKey",
  "displayKey",
  "avatarKey",
  "photoKey",
  "bucket",
  "requestIp",
  "ipAddress",
  "userAgent",
  "showEmail",
  "showPhone",
  "showCity",
  "listedInDirectory",
  "visibility",
  "contactVisibility",
  "notes",
  "mustChangePassword"
];
/** Keys that must never be serialized to anyone, admins included. */
const NEVER_KEYS = ["passwordHash", "tokenHash", "objectKey", "thumbKey", "displayKey", "avatarKey", "photoKey", "token", "refreshToken"];

let app: App;
let storage: S3Storage;
const mailer = new FakeMailer();
let viewer: { user: TestUser; auth: AuthInjectOptions };
let admin: { user: TestUser; auth: AuthInjectOptions };
let hidden: TestUser;
let open: TestUser;
let unlisted: TestUser;
let disabled: TestUser;
let roomId: string;
let mediaId: string;
let personId: string;
let relativeId: string;
/** Raw secrets planted in the database/cookies: none may ever appear in a body or frame. */
let secrets: string[] = [];

beforeAll(async () => {
  storage = new S3Storage({ ...createTestConfig(), ...S3_CONFIG }, systemClock);
  app = await createTestApp({ config: S3_CONFIG, storage, mailer });
});

afterAll(async () => {
  await app.close();
  storage.destroy();
});

async function member(options: Parameters<typeof createUser>[0] = {}): Promise<{ user: TestUser; auth: AuthInjectOptions }> {
  const user = await createUser({ emailVerified: true, ...options });
  return { user, auth: await bearerFor(user, await createSession(user.id)) };
}

/** Plant one person who hides everything, one who shows everything, and one who is unlisted, with data in every module. */
beforeEach(async () => {
  viewer = await member({ displayName: "Persona Lectora" });
  admin = await member({ role: "admin", displayName: "Persona Admin" });
  hidden = await createUser({
    emailVerified: true,
    displayName: "Persona Reservada",
    profile: {
      listedInDirectory: true,
      showEmail: false,
      showPhone: false,
      showCity: false,
      phone: HIDDEN.phone,
      city: HIDDEN.city,
      avatarKey: `avatars/${randomUUID()}/large.webp`,
      ...HIDDEN_CONTACTS,
      contactVisibility: {}
    }
  });
  open = await createUser({
    emailVerified: true,
    displayName: "Persona Abierta",
    profile: { listedInDirectory: true, showEmail: true, showPhone: true, showCity: true, phone: "5551112222", city: "Mérida" }
  });
  unlisted = await createUser({
    emailVerified: true,
    displayName: UNLISTED_NAME,
    profile: { listedInDirectory: false, ...UNLISTED_CONTACTS, ...ALL_SWITCHES_ON }
  });
  disabled = await createUser({
    emailVerified: true,
    status: "disabled",
    displayName: "Persona Dada De Baja",
    profile: { listedInDirectory: true, ...DISABLED_CONTACTS, ...ALL_SWITCHES_ON }
  });

  // Sessions with a planted IP and user agent, through the real login.
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: HIDDEN.ip,
    headers: { "user-agent": HIDDEN.userAgent },
    payload: { email: hidden.email, password: hidden.password }
  });
  expect(login.statusCode).toBe(200);
  const accessToken = login.json<{ accessToken: string }>().accessToken;
  const hiddenAuth = { headers: { authorization: `Bearer ${accessToken}` } };

  // Email tokens and invites exist (their hashes and raw values must never surface).
  const magic = await getTestDb().transaction((tx) =>
    createEmailToken(tx, { userId: hidden.id, email: hidden.email, purpose: MagicLinkPurpose.Login, requestIp: HIDDEN.ip, now: new Date() })
  );
  const inviteEmail = `invitada-${randomUUID()}@example.test`;
  const invite = await app.inject({
    method: "POST",
    url: "/api/admin/invites",
    remoteAddress: "203.0.113.9",
    ...admin.auth,
    payload: { email: inviteEmail, sendEmail: true }
  });
  expect(invite.statusCode).toBe(201);
  await mailQueue(app).onIdle();
  secrets = [accessToken, refreshCookie(login)?.value ?? "", magic.token, linkToken(mailer.lastTo(inviteEmail))].filter(
    (secret) => secret.length > 0
  );
  expect(secrets).toHaveLength(4);

  // An edition with an RSVP (with private notes), historical attendance and a photo.
  const edition = await insertCuencada({ year: YEAR });
  const rsvp = await app.inject({
    method: "PUT",
    url: `/api/cuencadas/${YEAR}/rsvp/me`,
    remoteAddress: HIDDEN.ip,
    ...hiddenAuth,
    payload: { status: "yes", guestCount: 2, notes: HIDDEN.rsvpNote }
  });
  expect(rsvp.statusCode).toBe(200);
  const media = await insertMedia({ cuencadaId: edition.id, uploadedByUserId: hidden.id, bucket: BUCKET, caption: "Foto" });
  mediaId = media.id;

  // Family: the hidden member, the unlisted member and an unlinked person.
  personId = (
    await insertPerson({
      userId: hidden.id,
      fullName: "Persona Reservada",
      birthYear: 1977,
      birthDate: HIDDEN.birthDate,
      birthplace: HIDDEN.birthplace
    })
  ).id;
  await insertPerson({ userId: unlisted.id, fullName: UNLISTED_NAME });
  // WP-4.3: the unlinked relative has a tree photo (only ever served as a presigned URL).
  const relative = await insertPerson({
    fullName: "Pariente Sin Cuenta",
    photoKey: `people/${randomUUID()}/${randomUUID()}-256.webp`,
    photoUpdatedAt: new Date()
  });
  relativeId = relative.id;
  await getTestDb().insert(cuencadaAttendance).values({ cuencadaId: edition.id, personId: relative.id });
  const viewerPerson = await insertPerson({ userId: viewer.user.id, fullName: "Persona Lectora" });
  // A member edge the viewer "made" between two people they did not create
  // (planted): it must not pull the hidden person into the viewer's circle.
  await getTestDb()
    .insert(personRelationships)
    .values({ kind: "parent_of", fromPersonId: personId, toPersonId: viewerPerson.id, createdByMember: true, createdByUserId: viewer.user.id });

  // Chat from the hidden member.
  const room = await insertGlobalRoom();
  roomId = room.id;
  await insertMessage({ roomId, senderUserId: hidden.id, body: "hola" });
  // A deleted message: only a tombstone may surface, never its body.
  await insertMessage({ roomId, senderUserId: hidden.id, body: HIDDEN.deletedChatBody, deletedAt: new Date(), deletedByUserId: hidden.id });
});

/** Every (key, string value) pair in a JSON value. */
function strings(value: unknown, key = ""): Array<[string, string]> {
  if (typeof value === "string") return [[key, value]];
  if (Array.isArray(value)) return value.flatMap((item) => strings(item, key));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([childKey, child]) => strings(child, childKey));
  }
  return [];
}

/** Every key in a JSON value. */
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)]);
  }
  return [];
}

interface ScanOptions {
  /** Emails this body may contain (the viewer's own, or a member who made theirs visible). */
  allowedEmails?: string[];
  /** Skip the IPv4 check (the caller's own session list). */
  allowIp?: boolean;
  /** Admin bodies may carry emails, IPs and visibility flags. */
  admin?: boolean;
  /** Forbidden keys this body may carry (the caller's own data). */
  allowKeys?: string[];
  /** The unlisted member's name must not appear (directory bodies). */
  directory?: boolean;
}

/**
 * Problems found in a serialized body. Presigned GET URLs are allowed only in
 * `thumbUrl`/`displayUrl`/`avatarUrl` and are checked separately, then removed
 * before the regex scan (their host carries the bucket name by design).
 */
function scan(label: string, body: unknown, options: ScanOptions = {}): string[] {
  const problems: string[] = [];
  const allowed = new Set((options.allowedEmails ?? []).map((email) => email.toLowerCase()));
  const signed = strings(body).filter(([, value]) => SIGNED_STORAGE_URL.test(value) || value.includes("linodeobjects.com"));
  for (const [key, value] of signed) {
    if (!SIGNED_URL_KEYS.has(key)) problems.push(`${label}: storage URL in "${key}"`);
    if (PRESIGNED_PUT.test(value)) problems.push(`${label}: presigned PUT URL in "${key}"`);
    if (value.includes("/originals/")) problems.push(`${label}: original object exposed in "${key}"`);
  }
  const signedValues = new Set(signed.map(([, value]) => value));
  const text = JSON.stringify(body, (_key, value: unknown) =>
    typeof value === "string" && signedValues.has(value) ? "[signed-url]" : value
  );

  const bodyKeys = new Set(keys(body));
  const allowedKeys = new Set(options.allowKeys ?? []);
  for (const key of options.admin === true ? NEVER_KEYS : FORBIDDEN_KEYS) {
    if (bodyKeys.has(key) && !allowedKeys.has(key)) problems.push(`${label}: forbidden key "${key}"`);
  }
  if (ARGON2.test(text)) problems.push(`${label}: argon2 hash`);
  if (JWT.test(text)) problems.push(`${label}: JWT`);
  if (S3_KEY.test(text)) problems.push(`${label}: raw object key`);
  for (const [key, value] of strings(body)) {
    if (!CURSOR_KEYS.has(key) && OPAQUE_TOKEN.test(value)) problems.push(`${label}: opaque token-shaped value in "${key}"`);
  }
  for (const secret of secrets) {
    if (text.includes(secret)) problems.push(`${label}: a planted raw token/secret`);
  }
  if (text.includes(HIDDEN.deletedChatBody)) problems.push(`${label}: body of a deleted chat message`);
  if (SHA256_HEX.test(text)) problems.push(`${label}: 64-hex digest (token hash?)`);
  if (PRESIGNED_PUT.test(text)) problems.push(`${label}: presigned PUT URL`);
  if (text.includes(HIDDEN.rsvpNote) && options.admin !== true) problems.push(`${label}: another member's RSVP notes`);
  if (options.admin !== true && (text.includes(HIDDEN.birthplace) || text.includes(HIDDEN.birthDate))) {
    problems.push(`${label}: a living person's birth date or birthplace outside their circle`);
  }
  if (options.admin !== true) {
    for (const email of text.match(EMAIL) ?? []) {
      if (!allowed.has(email.toLowerCase())) problems.push(`${label}: email ${email}`);
    }
    if (text.replace(/\D/g, "").includes(HIDDEN.phoneDigits)) problems.push(`${label}: hidden phone`);
    if (text.includes(HIDDEN.city)) problems.push(`${label}: hidden city`);
    const digitsOnly = text.replace(/\D/g, "");
    for (const planted of PLANTED_CONTACT_STRINGS) {
      const leaked = /^[0-9]+$/.test(planted) ? digitsOnly.includes(planted) : text.includes(planted);
      if (leaked) problems.push(`${label}: hidden/unlisted/disabled contact ${planted}`);
    }
    if (text.includes(BUCKET)) problems.push(`${label}: bucket name`);
    if (text.includes(HIDDEN.userAgent)) problems.push(`${label}: another member's user agent`);
    if (options.allowIp !== true && IPV4.test(text)) problems.push(`${label}: IP address`);
  }
  if (options.admin === true && text.includes(BUCKET)) problems.push(`${label}: bucket name`);
  if (options.directory === true && text.includes(UNLISTED_NAME)) problems.push(`${label}: unlisted member's name`);
  return problems;
}

/** Bearer headers for a planted user (fresh session). */
async function bearerAuth(user: TestUser): Promise<AuthInjectOptions> {
  return bearerFor(user, await createSession(user.id));
}

async function get(url: string, auth: { headers: Record<string, string> }): Promise<unknown> {
  const response = await app.inject({ method: "GET", url, remoteAddress: "203.0.113.50", ...auth });
  expect(response.statusCode, `${url}: ${response.body.slice(0, 300)}`).toBe(200);
  return response.json();
}

describe("member-facing reads never leak PII", () => {
  it("directory: hidden contact fields are absent; visible ones only for members who opted in", async () => {
    const list = await get("/api/directory", viewer.auth);
    const one = await get(`/api/directory/${hidden.id}`, viewer.auth);
    const problems = [
      ...scan("GET /api/directory", list, { allowedEmails: [open.email], directory: true }),
      ...scan("GET /api/directory?q=Listada", await get("/api/directory?q=Listada", viewer.auth), { directory: true }),
      ...scan("GET /api/directory/:id", one, { directory: true })
    ];
    expect(problems).toEqual([]);
    expect(one).not.toHaveProperty("email");
    expect(one).not.toHaveProperty("phone");
    expect(one).not.toHaveProperty("city");
    // WP-4.4: every switch off → an empty card; nothing hidden is in the body.
    expect(one).toHaveProperty("contacts", []);
    expect(JSON.stringify(list)).not.toContain(unlisted.id);
    expect(JSON.stringify(list)).not.toContain(disabled.id);
    const gone = await app.inject({ method: "GET", url: `/api/directory/${disabled.id}`, ...viewer.auth });
    expect(gone.statusCode).toBe(404);
    expect(scan("GET /api/directory/:disabled", gone.json(), { directory: true })).toEqual([]);
  });

  it("directory contacts never reach an unverified viewer", async () => {
    const unverified = await createUser({ emailVerified: false, displayName: "Persona Sin Verificar" });
    const auth = await bearerFor(unverified, await createSession(unverified.id));
    for (const url of ["/api/directory", `/api/directory/${open.id}`, `/api/directory/${hidden.id}`]) {
      const response = await app.inject({ method: "GET", url, ...auth });
      expect(response.statusCode, url).toBe(403);
      expect(response.body).not.toContain("contacts");
      expect(scan(`unverified ${url}`, response.json())).toEqual([]);
    }
  });

  it("family: people, person detail and tree carry no contact data, and unlisted accounts are not linked", async () => {
    const people = await get("/api/family/people", viewer.auth);
    const person = await get(`/api/family/people/${personId}`, viewer.auth);
    const tree = await get(`/api/family/tree?personId=${personId}&depth=3`, viewer.auth);
    const own = await get("/api/family/tree", viewer.auth);
    expect([
      ...scan("GET /api/family/people", people),
      ...scan("GET /api/family/people/:id", person),
      ...scan("GET /api/family/tree?personId", tree),
      ...scan("GET /api/family/tree", own)
    ]).toEqual([]);
    for (const body of [people, tree, own]) expect(JSON.stringify(body)).not.toContain(unlisted.id);
  });

  it("family tree photos (WP-4.3): presigned only in avatarUrl/photoUrl; the photo routes return no keys or bucket", async () => {
    const detail = await get(`/api/family/people/${relativeId}`, viewer.auth);
    expect(JSON.stringify(detail)).toContain("-512.webp");
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/family/people/${relativeId}/photo`,
      remoteAddress: "203.0.113.51",
      ...admin.auth
    });
    expect(removed.statusCode).toBe(200);
    const intent = await app.inject({
      method: "POST",
      url: `/api/family/people/${relativeId}/photo/uploads`,
      remoteAddress: "203.0.113.51",
      ...admin.auth,
      payload: { mimeType: "image/jpeg", byteSize: 1000 }
    });
    expect(intent.statusCode).toBe(201);
    // The intent legitimately carries a presigned PUT; it must not expose the key as a field.
    expect(Object.keys(intent.json<Record<string, unknown>>()).sort()).toEqual(["expiresAt", "headers", "uploadId", "uploadUrl"]);
    expect(
      [...scan("GET /api/family/people/:id (tree photo)", detail), ...scan("DELETE /api/family/people/:id/photo", removed.json(), { admin: true })]
    ).toEqual([]);
  });

  it("family (WP-4.1): living people's dates and birthplace stay inside the circle; revision routes are admin-only", async () => {
    const tree = await get(`/api/family/tree?personId=${personId}&depth=4`, viewer.auth);
    const own = await get("/api/family/tree?depth=4", viewer.auth);
    const person = (await get(`/api/family/people/${personId}`, viewer.auth)) as { birthYear: number | null };
    expect(person.birthYear).toBeNull();
    expect([...scan("GET /api/family/tree?depth=4", tree), ...scan("GET /api/family/tree (own)", own)]).toEqual([]);
    // Positive control: the person themself and admins do see them.
    const self = await app.inject({ method: "GET", url: `/api/family/people/${personId}`, remoteAddress: "203.0.113.51", ...(await bearerAuth(hidden)) });
    expect(self.body).toContain(HIDDEN.birthplace);
    expect(JSON.stringify(await get(`/api/family/people/${personId}`, admin.auth))).toContain(HIDDEN.birthDate);
    for (const url of [
      "/api/admin/family/activity",
      `/api/admin/people/${personId}/revisions`,
      "/api/admin/family/duplicates",
      `/api/admin/people/${personId}/merge-preview?duplicateId=00000000-0000-4000-8000-000000000001`
    ]) {
      const response = await app.inject({ method: "GET", url, remoteAddress: "203.0.113.50", ...viewer.auth });
      expect(response.statusCode, url).toBe(403);
      expect(response.body).not.toContain(HIDDEN.birthplace);
    }
  });

  it("one tree (WP-6.4): overview names only, living years outside the circle hidden, others' proposals and notes never shown", async () => {
    const [unlistedPerson] = await getTestDb().select({ id: people.id }).from(people).where(eq(people.userId, unlisted.id));
    if (unlistedPerson === undefined) throw new Error("no unlisted person");
    // The unlisted member is a child of the hidden one; the hidden person is the root.
    await getTestDb().insert(personRelationships).values({ kind: "parent_of", fromPersonId: personId, toPersonId: unlistedPerson.id });
    const root = await app.inject({ method: "PUT", url: "/api/admin/family/settings", remoteAddress: "203.0.113.51", payload: { rootPersonId: personId }, ...admin.auth });
    expect(root.statusCode).toBe(200);
    const hiddenAuth = await bearerAuth(hidden);
    const proposed = await app.inject({
      method: "POST",
      url: "/api/family/proposals",
      remoteAddress: "203.0.113.52",
      payload: { kind: "same_person", fromPersonId: relativeId, toPersonId: unlistedPerson.id, note: "nota-propuesta-w64" },
      ...hiddenAuth
    });
    expect(proposed.statusCode, proposed.body).toBe(201);

    const overview = (await get("/api/family/overview?depth=3", viewer.auth)) as { nodes: Array<Record<string, unknown>> };
    const extended = await get(`/api/family/tree/extended?personId=${unlistedPerson.id}`, viewer.auth);
    const settings = await get("/api/family/settings", viewer.auth);
    const path = await get(`/api/family/overview/path?personId=${unlistedPerson.id}`, viewer.auth);
    const mine = await get("/api/family/proposals", viewer.auth);
    const bodies: Array<[string, unknown]> = [
      ["GET /api/family/overview", overview],
      ["GET /api/family/tree/extended", extended],
      ["GET /api/family/settings", settings],
      ["GET /api/family/overview/path", path],
      ["GET /api/family/proposals", mine]
    ];
    expect(bodies.flatMap(([label, body]) => scan(label, body))).toEqual([]);
    // Names only: no photo, no account id; the hidden living person's year stays hidden from the viewer.
    expect(overview.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([personId, unlistedPerson.id]));
    for (const node of overview.nodes) {
      expect(node).not.toHaveProperty("avatarUrl");
      expect(node).not.toHaveProperty("userId");
    }
    expect(overview.nodes.find((node) => node.id === personId)?.birthYear).toBeNull();
    expect(JSON.stringify(overview)).not.toContain(unlisted.id);
    // Another member's proposal (and its note) never reaches the viewer.
    expect(JSON.stringify(mine)).not.toContain("nota-propuesta-w64");
    const others = await app.inject({ method: "GET", url: "/api/admin/family/proposals", remoteAddress: "203.0.113.50", ...viewer.auth });
    expect(others.statusCode).toBe(403);
    expect(others.body).not.toContain("nota-propuesta-w64");
    const branches = await app.inject({ method: "GET", url: "/api/admin/family/branches", remoteAddress: "203.0.113.50", ...viewer.auth });
    expect(branches.statusCode).toBe(403);
    // Admin report: no account ids, linked accounts as a count.
    const report = await get("/api/admin/family/branches?includeSingles=true", admin.auth);
    for (const user of [hidden, unlisted, viewer.user, open]) expect(JSON.stringify(report)).not.toContain(user.id);
    expect(scan("GET /api/admin/family/branches", report, { admin: true })).toEqual([]);
  });

  it("attendees and RSVP summary: names only, no notes, emails or keys", async () => {
    const attendees = await get(`/api/cuencadas/${YEAR}/attendees`, viewer.auth);
    const summary = await get(`/api/cuencadas/${YEAR}/rsvp/summary`, viewer.auth);
    const mine = await get(`/api/cuencadas/${YEAR}/rsvp/me`, viewer.auth);
    expect([
      ...scan("GET attendees", attendees),
      ...scan("GET rsvp/summary", summary),
      ...scan("GET rsvp/me", mine)
    ]).toEqual([]);
  });

  it("chat: rooms and history expose names and avatars only", async () => {
    const rooms = await get("/api/chat/rooms", viewer.auth);
    const history = await get(`/api/chat/rooms/${roomId}/messages`, viewer.auth);
    expect([...scan("GET /api/chat/rooms", rooms), ...scan("GET messages", history)]).toEqual([]);
    // The planted deleted message is there as a tombstone, without its body.
    expect(JSON.stringify(history)).not.toContain(HIDDEN.deletedChatBody);
  });

  it("chat WebSocket frames (presence, message, preview, deletion) expose names and avatars only", async () => {
    const clients: ChatTestClient[] = [];
    try {
      const asChatMember = async (user: TestUser) => {
        const session = await createSession(user.id);
        return { user, sessionId: session.id, auth: await bearerFor(user, session) };
      };
      const reader = await connectMember(app, await asChatMember(viewer.user));
      clients.push(reader);
      const sender = await connectMember(app, await asChatMember(hidden));
      clients.push(sender);
      sender.send({ type: "send", roomId, body: "mensaje por socket", clientMessageId: randomUUID() });
      const message = await reader.waitFor(frameOf("message", (frame) => frame.message.body === "mensaje por socket"));
      const deleted = await app.inject({ method: "DELETE", url: `/api/chat/messages/${message.message.id}`, ...admin.auth });
      expect(deleted.statusCode).toBe(204);
      await reader.waitFor(frameOf("message_deleted"));
      expect(reader.frames.length).toBeGreaterThan(2);
      const problems = reader.frames.flatMap((frame, index) => scan(`ws frame ${index} (${frame.type})`, frame));
      expect(problems).toEqual([]);
      // After deletion the frame stream carries the tombstone only; the earlier "message" frame is the live delivery.
      const afterDelete = reader.frames.slice(reader.frames.findIndex((frame) => frame.type === "message_deleted"));
      expect(JSON.stringify(afterDelete)).not.toContain("mensaje por socket");
    } finally {
      for (const client of clients) client.ws.terminate();
    }
  });

  it("media: list and item carry presigned GET URLs only in the URL fields", async () => {
    const list = await get(`/api/cuencadas/${YEAR}/media`, viewer.auth);
    const item = await get(`/api/media/${mediaId}`, viewer.auth);
    expect([...scan("GET media list", list), ...scan("GET /api/media/:id", item)]).toEqual([]);
    expect(JSON.stringify(item)).toMatch(/X-Amz-Signature/);
  });

  it("events (WP-5.3): unlisted participants carry no id or avatar; a participants event's title never reaches a non-participant", async () => {
    const organizer = await member({ displayName: "Organizadora W53" });
    await getTestDb()
      .update(profiles)
      .set({ avatarKey: `avatars/${unlisted.id}/${randomUUID()}-256.webp` })
      .where(eq(profiles.userId, unlisted.id));
    const shared = await insertEvent({
      title: "Comida abierta W53",
      organizerId: organizer.user.id,
      participantIds: [unlisted.id, viewer.user.id, hidden.id]
    });
    const secret = await insertEvent({ title: "Viaje secreto W53", visibility: "participants", organizerId: organizer.user.id, participantIds: [unlisted.id] });
    await insertAlbumMedia(shared.album, { uploadedByUserId: organizer.user.id });
    await insertAlbumMedia(secret.album, { uploadedByUserId: organizer.user.id });
    await addParticipant(secret.event.id, hidden.id, "participant", organizer.user.id);
    const bodies: Array<[string, unknown]> = [
      ["GET /api/events", await get("/api/events?year=2026", viewer.auth)],
      ["GET /api/events past", await get("/api/events?when=past", viewer.auth)],
      ["GET event detail", await get(`/api/events/${shared.event.year}/${shared.event.slug}`, viewer.auth)],
      ["GET /api/events/notices", await get("/api/events/notices", viewer.auth)],
      ["GET /api/chat/rooms (events)", await get("/api/chat/rooms", viewer.auth)],
      ["GET album media", await get(`/api/events/${shared.event.id}/albums/${shared.album.id}/media`, viewer.auth)]
    ];
    // `visibility` here is the event's audience enum (members | participants), not a profile flag.
    const problems = bodies.flatMap(([label, body]) => scan(label, body, { allowKeys: ["visibility"] }));
    for (const [label, body] of bodies) {
      const text = JSON.stringify(body);
      if (text.includes("Viaje secreto W53")) problems.push(`${label}: a participants event's title`);
      if (text.includes(unlisted.id)) problems.push(`${label}: the unlisted participant's id`);
    }
    const detail = bodies[2]?.[1] as { participants: Array<{ displayName: string; avatarUrl: string | null; userId?: string }> }; // eventDetailSchema shape
    const unlistedRow = detail.participants.find((row) => row.displayName === UNLISTED_NAME);
    if (unlistedRow === undefined || unlistedRow.avatarUrl !== null || "userId" in unlistedRow) {
      problems.push("event detail: the unlisted participant's avatar or id");
    }
    expect(problems).toEqual([]);
  });

  it("notifications (WP-6.1): an actor who became unlisted carries no id or avatar; an invisible event's title never reaches the feed or a push", async () => {
    const editionId = (await getTestDb().select({ id: cuencadas.id }).from(cuencadas).where(eq(cuencadas.year, YEAR)))[0]?.id;
    if (editionId === undefined) throw new Error("no edition");
    const photo = await insertMedia({ cuencadaId: editionId, uploadedByUserId: viewer.user.id, bucket: BUCKET });
    await getTestDb()
      .update(profiles)
      .set({ avatarKey: `avatars/${unlisted.id}/${randomUUID()}-256.webp` })
      .where(eq(profiles.userId, unlisted.id));
    const organizer = await member({ displayName: "Organizadora W61" });
    const secret = await insertEvent({ title: "Viaje secreto W61", visibility: "participants", organizerId: organizer.user.id });
    const ids = await getTestDb().transaction(async (tx) => [
      await recordNotification(tx, { recipientUserId: viewer.user.id, actorUserId: unlisted.id, kind: "photo_liked", target: { mediaId: photo.id } }),
      await recordNotification(tx, { recipientUserId: viewer.user.id, actorUserId: organizer.user.id, kind: "event_added", target: { eventId: secret.event.id } })
    ]);
    const session = await createSession(viewer.user.id);
    const reader = await connectMember(app, { user: viewer.user, sessionId: session.id, auth: await bearerFor(viewer.user, session) });
    try {
      await pushNotifications(app, ids.filter((id): id is string => id !== null));
      const frame = await reader.waitFor(frameOf("notification"));
      const bodies: Array<[string, unknown]> = [
        ["GET /api/notifications", await get("/api/notifications", viewer.auth)],
        ["GET /api/notifications/unread-count", await get("/api/notifications/unread-count", viewer.auth)],
        ["ws notification frame", frame]
      ];
      const problems = bodies.flatMap(([label, body]) => scan(label, body));
      for (const [label, body] of bodies) {
        const text = JSON.stringify(body);
        if (text.includes("Viaje secreto W61")) problems.push(`${label}: an invisible event's title`);
        if (text.includes(unlisted.id)) problems.push(`${label}: the unlisted actor's id`);
        if (text.includes("avatars/")) problems.push(`${label}: the unlisted actor's avatar`);
      }
      expect(problems).toEqual([]);
      expect(frame.notification.actor).toEqual({ name: UNLISTED_NAME, avatarUrl: null });
      expect(reader.ofType("notification")).toHaveLength(1);
    } finally {
      reader.ws.terminate();
    }
  });

  it("own profile, /me and own sessions show the caller's own data only", async () => {
    const profile = await get("/api/profile/me", viewer.auth);
    const me = await get("/api/me", viewer.auth);
    const sessionsList = await get("/api/auth/sessions", viewer.auth);
    const problems = [
      // The own profile legitimately includes its visibility switches and phone.
      ...scan("GET /api/profile/me", profile, {
        allowedEmails: [viewer.user.email],
        allowKeys: ["visibility", "showEmail", "showPhone", "showCity", "listedInDirectory", "mustChangePassword"]
      }),
      ...scan("GET /api/me", me, { allowedEmails: [viewer.user.email], allowKeys: ["mustChangePassword"] }),
      // Own sessions list their own IP and user agent (and only those).
      ...scan("GET /api/auth/sessions", sessionsList, { allowIp: true, allowKeys: ["ipAddress", "userAgent"] })
    ];
    expect(problems).toEqual([]);
  });

  it("public and member edition reads, announcements and home carry no PII", async () => {
    const anon = { headers: {} };
    const problems = [
      ...scan("GET /api/cuencadas", await get("/api/cuencadas", anon)),
      ...scan("GET /api/cuencadas/home", await get("/api/cuencadas/home", anon)),
      ...scan(`GET /api/cuencadas/${YEAR}`, await get(`/api/cuencadas/${YEAR}`, anon)),
      ...scan("GET members", await get(`/api/cuencadas/${YEAR}/members`, viewer.auth)),
      ...scan("GET /api/announcements", await get("/api/announcements", viewer.auth))
    ];
    expect(problems).toEqual([]);
  });
});

describe("admin console never serializes secrets", () => {
  it("users, invites, audit log, media queue, RSVPs and summary carry no hashes, tokens, keys or PUT URLs", async () => {
    const edition = await get("/api/admin/cuencadas", admin.auth);
    const editionId = (edition as Array<{ id: string; year: number }>).find((row) => row.year === YEAR)?.id;
    expect(editionId).toBeDefined();
    // A family revision exists (its snapshots are admin-only PII, but never keys or tokens).
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/admin/people/${personId}`,
      remoteAddress: "203.0.113.9",
      payload: { nickname: "Reservada" },
      ...admin.auth
    });
    expect(edit.statusCode).toBe(200);
    // WP-4.5: a possible duplicate of the hidden member's person (admin-only preview and pairs).
    const duplicate = await insertPerson({ fullName: "Persona Reservada" });
    const bodies: Array<[string, unknown]> = [
      ["GET /api/admin/users", await get("/api/admin/users", admin.auth)],
      ["GET /api/admin/invites", await get("/api/admin/invites", admin.auth)],
      ["GET /api/admin/invites/people", await get("/api/admin/invites/people?q=a", admin.auth)],
      ["GET /api/admin/audit-logs", await get("/api/admin/audit-logs?limit=100", admin.auth)],
      ["GET /api/admin/media", await get("/api/admin/media", admin.auth)],
      ["GET /api/admin/media/:id/reports", await get(`/api/admin/media/${mediaId}/reports`, admin.auth)],
      ["GET rsvps", await get(`/api/admin/cuencadas/${editionId}/rsvps`, admin.auth)],
      ["GET attendance", await get(`/api/admin/cuencadas/${editionId}/attendance`, admin.auth)],
      ["GET /api/admin/summary", await get("/api/admin/summary", admin.auth)],
      ["GET /api/admin/family/activity", await get("/api/admin/family/activity", admin.auth)],
      ["GET /api/admin/people/:id/revisions", await get(`/api/admin/people/${personId}/revisions`, admin.auth)],
      ["GET /api/admin/family/duplicates", await get("/api/admin/family/duplicates", admin.auth)],
      [
        "GET /api/admin/people/:id/merge-preview",
        await get(`/api/admin/people/${personId}/merge-preview?duplicateId=${duplicate.id}`, admin.auth)
      ]
    ];
    expect(bodies.flatMap(([label, body]) => scan(label, body, { admin: true }))).toEqual([]);
  });

  it("the RSVP CSV export carries no hashes, keys or storage URLs", async () => {
    const list = (await get("/api/admin/cuencadas", admin.auth)) as Array<{ id: string; year: number }>;
    const editionId = list.find((row) => row.year === YEAR)?.id ?? "";
    const response = await app.inject({ method: "GET", url: `/api/admin/cuencadas/${editionId}/rsvps.csv`, ...admin.auth });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(ARGON2);
    expect(response.body).not.toMatch(SHA256_HEX);
    expect(response.body).not.toContain(BUCKET);
    expect(response.body).not.toContain("avatars/");
  });
});

describe("the PII scanner itself", () => {
  it("flags every planted leak class (so a green run means something)", () => {
    const leaky = {
      email: "otra.persona@example.test",
      // Reformatted on purpose: matched on digits.
      phone: "555.777.01 23",
      passwordHash: "$argon2id$v=19$m=4096,t=2,p=1$abc$def",
      digest: "a".repeat(64),
      ip: HIDDEN.ip,
      thumbUrl: `https://${BUCKET}.us-east-1.linodeobjects.com/cuencadas/2099/originals/x.jpg?x-id=PutObject&X-Amz-Signature=abc`,
      link: `https://${BUCKET}.us-east-1.linodeobjects.com/k?X-Amz-Signature=abc`,
      showPhone: false,
      session: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4In0.c2lnbmF0dXJlLXZhbHVl",
      key: "avatars/0f2c4e1a-0000-4000-8000-000000000000/large.webp",
      opaque: "A".repeat(43),
      planted: `prefix ${secrets[0] ?? "missing"} suffix`,
      body: HIDDEN.deletedChatBody,
      name: UNLISTED_NAME,
      birthplace: HIDDEN.birthplace,
      contacts: [{ kind: "instagram", href: `https://instagram.com/${HIDDEN_CONTACTS.instagram}` }],
      wa: "wa.me/1 202 555 0199",
      contactVisibility: {}
    };
    const problems = scan("synthetic", leaky, { directory: true });
    expect(scan("synthetic tree photo", { photo: "people/0f2c4e1a-0000-4000-8000-000000000000/0f2c4e1a-0000-4000-8000-000000000001-256.webp", photoKey: "x" })).toEqual(
      expect.arrayContaining([expect.stringContaining("raw object key"), expect.stringContaining('forbidden key "photoKey"')])
    );
    for (const fragment of [
      "JWT",
      "raw object key",
      'opaque token-shaped value in "opaque"',
      "planted raw token",
      "deleted chat message",
      "unlisted member's name",
      "email otra.persona",
      "hidden phone",
      'forbidden key "passwordHash"',
      "argon2",
      "64-hex",
      "IP address",
      "presigned PUT",
      "original object",
      'storage URL in "link"',
      'forbidden key "showPhone"',
      "birth date or birthplace outside their circle",
      'forbidden key "contactVisibility"',
      `contact ${HIDDEN_CONTACTS.instagram}`,
      "contact 12025550199"
    ]) {
      expect(
        problems.some((problem) => problem.includes(fragment)),
        fragment
      ).toBe(true);
    }
  });
});
