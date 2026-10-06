/**
 * PII leakage (WP-2.3) [SEC]: the serialized JSON of every member-facing
 * read (directory, family, attendees, chat, media, profile, cuencadas) and of
 * the admin console never contains another person's hidden contact data,
 * hidden-flag fields, emails/phones of others, password or token hashes, IPs,
 * object keys, bucket names or presigned PUT URLs.
 *
 * Storage is the real `S3Storage` (presigning is offline), so presigned GET
 * URLs look exactly like production ones and can be told apart from PUTs.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../app.js";
import { cuencadaAttendance, MagicLinkPurpose } from "../../db/schema/index.js";
import { systemClock } from "../../lib/clock.js";
import { S3Storage } from "../../lib/storage/s3.js";
import { createEmailToken } from "../../modules/auth/emailTokens.js";
import { createTestApp, createTestConfig } from "../../../test/helpers/app.js";
import { insertGlobalRoom, insertMessage } from "../../../test/helpers/chat.js";
import { insertCuencada } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, bearerFor, createSession, createUser, type TestUser } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import { insertPerson } from "../../../test/helpers/family.js";
import { insertMedia } from "../../../test/helpers/media.js";

const BUCKET = "w23-pii-bucket";
const S3_CONFIG = {
  S3_ENDPOINT: "https://us-southeast-1.linodeobjects.com",
  S3_REGION: "us-southeast-1",
  S3_BUCKET: BUCKET,
  S3_ACCESS_KEY_ID: "AKIAW23FAKEFAKEFAKE",
  S3_SECRET_ACCESS_KEY: "w23-fake-secret-key-not-real",
  S3_PUBLIC_BASE_URL: ""
};
const YEAR = 2099;
/** Planted identifiers of the member who hides everything. */
const HIDDEN = {
  phone: "5557770123",
  city: "Ciudad-Oculta-W23",
  ip: "198.51.100.23",
  userAgent: "W23-Secret-Agent/1.0",
  rsvpNote: "nota-privada-w23"
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const ARGON2 = /\$argon2/i;
const SHA256_HEX = /\b[a-f0-9]{64}\b/i;
const PRESIGNED_PUT = /x-id=PutObject|X-Fake-Signature=put/i;
const SIGNED_STORAGE_URL = /linodeobjects\.com\/[^"]*X-Amz-Signature/i;
/** Keys whose values may be presigned GET URLs. */
const SIGNED_URL_KEYS = new Set(["thumbUrl", "displayUrl", "avatarUrl"]);
/** Keys that must never be serialized to non-admins. */
const FORBIDDEN_KEYS = [
  "passwordHash",
  "tokenHash",
  "objectKey",
  "thumbKey",
  "displayKey",
  "avatarKey",
  "bucket",
  "requestIp",
  "ipAddress",
  "userAgent",
  "showEmail",
  "showPhone",
  "showCity",
  "listedInDirectory",
  "visibility",
  "notes",
  "mustChangePassword"
];
/** Keys that must never be serialized to anyone, admins included. */
const NEVER_KEYS = ["passwordHash", "tokenHash", "objectKey", "thumbKey", "displayKey", "avatarKey", "token", "refreshToken"];

let app: App;
let storage: S3Storage;
let viewer: { user: TestUser; auth: AuthInjectOptions };
let admin: { user: TestUser; auth: AuthInjectOptions };
let hidden: TestUser;
let open: TestUser;
let unlisted: TestUser;
let roomId: string;
let mediaId: string;
let personId: string;

beforeAll(async () => {
  storage = new S3Storage({ ...createTestConfig(), ...S3_CONFIG }, systemClock);
  app = await createTestApp({ config: S3_CONFIG, storage, mailer: new FakeMailer() });
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
      avatarKey: `avatars/${randomUUID()}/large.webp`
    }
  });
  open = await createUser({
    emailVerified: true,
    displayName: "Persona Abierta",
    profile: { listedInDirectory: true, showEmail: true, showPhone: true, showCity: true, phone: "5551112222", city: "Mérida" }
  });
  unlisted = await createUser({ emailVerified: true, displayName: "Persona No Listada", profile: { listedInDirectory: false } });

  // Sessions with a planted IP and user agent, through the real login.
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: HIDDEN.ip,
    headers: { "user-agent": HIDDEN.userAgent },
    payload: { email: hidden.email, password: hidden.password }
  });
  expect(login.statusCode).toBe(200);
  const hiddenAuth = { headers: { authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}` } };

  // Email tokens and invites exist (their hashes must never surface).
  await getTestDb().transaction((tx) =>
    createEmailToken(tx, { userId: hidden.id, email: hidden.email, purpose: MagicLinkPurpose.Login, requestIp: HIDDEN.ip, now: new Date() })
  );
  const invite = await app.inject({
    method: "POST",
    url: "/api/admin/invites",
    remoteAddress: "203.0.113.9",
    ...admin.auth,
    payload: { email: `invitada-${randomUUID()}@example.test`, sendEmail: true }
  });
  expect(invite.statusCode).toBe(201);

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
  personId = (await insertPerson({ userId: hidden.id, fullName: "Persona Reservada" })).id;
  await insertPerson({ userId: unlisted.id, fullName: "Persona No Listada" });
  const relative = await insertPerson({ fullName: "Pariente Sin Cuenta" });
  await getTestDb().insert(cuencadaAttendance).values({ cuencadaId: edition.id, personId: relative.id });
  await insertPerson({ userId: viewer.user.id, fullName: "Persona Lectora" });

  // Chat from the hidden member.
  const room = await insertGlobalRoom();
  roomId = room.id;
  await insertMessage({ roomId, senderUserId: hidden.id, body: "hola" });
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
  if (SHA256_HEX.test(text)) problems.push(`${label}: 64-hex digest (token hash?)`);
  if (PRESIGNED_PUT.test(text)) problems.push(`${label}: presigned PUT URL`);
  if (text.includes(HIDDEN.rsvpNote) && options.admin !== true) problems.push(`${label}: another member's RSVP notes`);
  if (options.admin !== true) {
    for (const email of text.match(EMAIL) ?? []) {
      if (!allowed.has(email.toLowerCase())) problems.push(`${label}: email ${email}`);
    }
    if (text.includes(HIDDEN.phone)) problems.push(`${label}: hidden phone`);
    if (text.includes(HIDDEN.city)) problems.push(`${label}: hidden city`);
    if (text.includes(BUCKET)) problems.push(`${label}: bucket name`);
    if (text.includes(HIDDEN.userAgent)) problems.push(`${label}: another member's user agent`);
    if (options.allowIp !== true && IPV4.test(text)) problems.push(`${label}: IP address`);
  }
  if (options.admin === true && text.includes(BUCKET)) problems.push(`${label}: bucket name`);
  return problems;
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
      ...scan("GET /api/directory", list, { allowedEmails: [open.email] }),
      ...scan("GET /api/directory/:id", one)
    ];
    expect(problems).toEqual([]);
    expect(one).not.toHaveProperty("email");
    expect(one).not.toHaveProperty("phone");
    expect(one).not.toHaveProperty("city");
    expect(JSON.stringify(list)).not.toContain(unlisted.id);
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
  });

  it("media: list and item carry presigned GET URLs only in the URL fields", async () => {
    const list = await get(`/api/cuencadas/${YEAR}/media`, viewer.auth);
    const item = await get(`/api/media/${mediaId}`, viewer.auth);
    expect([...scan("GET media list", list), ...scan("GET /api/media/:id", item)]).toEqual([]);
    expect(JSON.stringify(item)).toMatch(/X-Amz-Signature/);
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
    const bodies: Array<[string, unknown]> = [
      ["GET /api/admin/users", await get("/api/admin/users", admin.auth)],
      ["GET /api/admin/invites", await get("/api/admin/invites", admin.auth)],
      ["GET /api/admin/audit-logs", await get("/api/admin/audit-logs?limit=100", admin.auth)],
      ["GET /api/admin/media", await get("/api/admin/media", admin.auth)],
      ["GET /api/admin/media/:id/reports", await get(`/api/admin/media/${mediaId}/reports`, admin.auth)],
      ["GET rsvps", await get(`/api/admin/cuencadas/${editionId}/rsvps`, admin.auth)],
      ["GET attendance", await get(`/api/admin/cuencadas/${editionId}/attendance`, admin.auth)],
      ["GET /api/admin/summary", await get("/api/admin/summary", admin.auth)]
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
      phone: HIDDEN.phone,
      passwordHash: "$argon2id$v=19$m=4096,t=2,p=1$abc$def",
      digest: "a".repeat(64),
      ip: HIDDEN.ip,
      thumbUrl: `https://${BUCKET}.us-southeast-1.linodeobjects.com/cuencadas/2099/originals/x.jpg?x-id=PutObject&X-Amz-Signature=abc`,
      link: `https://${BUCKET}.us-southeast-1.linodeobjects.com/k?X-Amz-Signature=abc`,
      showPhone: false
    };
    const problems = scan("synthetic", leaky);
    for (const fragment of [
      "email otra.persona",
      "hidden phone",
      'forbidden key "passwordHash"',
      "argon2",
      "64-hex",
      "IP address",
      "presigned PUT",
      "original object",
      'storage URL in "link"',
      'forbidden key "showPhone"'
    ]) {
      expect(
        problems.some((problem) => problem.includes(fragment)),
        fragment
      ).toBe(true);
    }
  });
});
