/**
 * WP-4.4 [SEC]: `PATCH /api/profile/me/contacts`, `OwnProfile.contacts` and
 * the directory contact card. Fictional fixtures only.
 */
import type { DirectoryEntry, OwnProfile, Page } from "@cuencada/types";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import {
  type AuthInjectOptions,
  bearerFor,
  createSession,
  createUser,
  type CreateUserOptions,
  type TestUser
} from "../../../test/helpers/factories.js";
import type { App } from "../../app.js";
import { auditLogs, profiles } from "../../db/schema/index.js";

let app: App;
let logs: string[];

beforeEach(async () => {
  logs = [];
  app = await createTestApp({ logStream: { write: (line) => logs.push(line) } });
});

afterEach(async () => {
  await app.close();
});

async function member(options: CreateUserOptions = {}): Promise<{ user: TestUser; auth: AuthInjectOptions }> {
  const user = await createUser({ emailVerified: true, ...options });
  return { user, auth: await bearerFor(user, await createSession(user.id)) };
}

async function patchContacts(auth: AuthInjectOptions, payload: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const response = await app.inject({ method: "PATCH", url: "/api/profile/me/contacts", ...auth, payload });
  return { status: response.statusCode, body: response.body };
}

function errorCode(body: string): string {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
    const error: unknown = parsed.error;
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  }
  return "";
}

/** Every contact filled in, as a member would type them. */
const TYPED = {
  phone: "555 010 0101",
  whatsapp: "+1 (202) 555-0147",
  instagram: "@prima.ficticia",
  facebook: "prima.ficticia",
  tiktok: "@prima_ficticia",
  linkedin: "prima-ficticia",
  github: "prima-ficticia",
  website: "https://example.com/prima"
} as const;

describe("PATCH /api/profile/me/contacts", () => {
  it("normalizes and stores every contact, maps visibility to the columns and the jsonb, and returns OwnProfile.contacts", async () => {
    const { user, auth } = await member();

    const response = await patchContacts(auth, {
      ...TYPED,
      visibility: { email: true, phone: true, instagram: true, website: false }
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as OwnProfile; // response validated by ownProfileSchema on the server
    expect(body.phone).toBe("+525550100101");
    expect(body.visibility.showEmail).toBe(true);
    expect(body.visibility.showPhone).toBe(true);
    expect(body.contacts).toEqual({
      whatsapp: "+12025550147",
      instagram: "prima.ficticia",
      facebook: "prima.ficticia",
      tiktok: "prima_ficticia",
      linkedin: "prima-ficticia",
      github: "prima-ficticia",
      website: "https://example.com/prima",
      visibility: {
        email: true,
        phone: true,
        whatsapp: false,
        instagram: true,
        facebook: false,
        tiktok: false,
        linkedin: false,
        github: false,
        website: false
      }
    });
    expect(body).not.toHaveProperty("phoneNeedsConfirmation");
    const [row] = await getTestDb().select().from(profiles).where(eq(profiles.userId, user.id));
    // email/phone never go into the jsonb (its CHECK would reject them).
    expect(row?.contactVisibility).toEqual({ instagram: true, website: false });
    expect(row?.showEmail).toBe(true);
    expect(row?.showPhone).toBe(true);
  });

  it("merges visibility switches into the stored map and leaves omitted fields alone", async () => {
    const { user, auth } = await member({
      profile: { instagram: "prima.ficticia", github: "prima-ficticia", contactVisibility: { instagram: true, github: true } }
    });

    const response = await patchContacts(auth, { visibility: { github: false, tiktok: true } });

    expect(response.status).toBe(200);
    const [row] = await getTestDb().select().from(profiles).where(eq(profiles.userId, user.id));
    expect(row?.contactVisibility).toEqual({ instagram: true, github: false, tiktok: true });
    expect(row?.instagram).toBe("prima.ficticia");
    expect(row?.github).toBe("prima-ficticia");
  });

  it("clears a contact with null or a blank string and stores WhatsApp exactly as sent (never inferred)", async () => {
    const { user, auth } = await member({ profile: { instagram: "prima.ficticia", website: "https://example.com/" } });

    const response = await patchContacts(auth, { instagram: null, website: "  ", phone: "5550100101" });

    expect(response.status).toBe(200);
    const [row] = await getTestDb().select().from(profiles).where(eq(profiles.userId, user.id));
    expect(row?.instagram).toBeNull();
    expect(row?.website).toBeNull();
    expect(row?.phone).toBe("+525550100101");
    expect(row?.whatsapp).toBeNull();
  });

  it.each([
    ["a pasted Instagram URL", { instagram: "https://instagram.com/prima.ficticia" }],
    ["a TikTok handle with a slash", { tiktok: "prima/ficticia" }],
    ["a LinkedIn profile URL", { linkedin: "linkedin.com/in/prima-ficticia" }],
    ["an http website", { website: "http://example.com" }],
    ["a javascript: website", { website: "javascript:alert(1)" }],
    ["an ambiguous 11-digit phone", { phone: "15550100101" }],
    ["a WhatsApp number with letters", { whatsapp: "+52 55 ABC" }],
    ["an unknown key", { email: "otra@example.com" }],
    ["a mass-assigned column", { showCity: true }],
    ["an unknown visibility key", { visibility: { city: true } }],
    ["an empty visibility patch", { visibility: {} }],
    ["an empty body", {}]
  ])("answers 400 VALIDATION for %s and writes nothing", async (_label, payload) => {
    const { user, auth } = await member({ profile: { instagram: "original.ficticia" } });
    const [before] = await getTestDb().select().from(profiles).where(eq(profiles.userId, user.id));

    const response = await patchContacts(auth, payload);

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("VALIDATION");
    const [after] = await getTestDb().select().from(profiles).where(eq(profiles.userId, user.id));
    expect(after).toEqual(before);
  });

  it("only ever writes the caller's own row", async () => {
    const { auth } = await member();
    const other = await createUser({ emailVerified: true, profile: { instagram: "otra.ficticia" } });
    const [before] = await getTestDb().select().from(profiles).where(eq(profiles.userId, other.id));

    const response = await patchContacts(auth, { instagram: "mia.ficticia", visibility: { instagram: true } });

    expect(response.status).toBe(200);
    const [after] = await getTestDb().select().from(profiles).where(eq(profiles.userId, other.id));
    expect(after).toEqual(before);
  });

  it("audits the changed field names only, never values, and logs no contact value", async () => {
    const { user, auth } = await member();

    const response = await patchContacts(auth, { instagram: "prima.ficticia", phone: "5550100101", visibility: { instagram: true } });

    expect(response.status).toBe(200);
    const [entry] = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.actorUserId, user.id), eq(auditLogs.action, "profile.updated")))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(entry?.metadata).toEqual({ fields: ["contacts.instagram", "contacts.phone", "contacts.visibility.instagram"] });
    const text = `${JSON.stringify(entry)}\n${logs.join("\n")}`;
    expect(text).not.toContain("prima.ficticia");
    expect(text).not.toContain("5550100101");
  });

  it("answers 401 without a token and 403 while a password change is pending", async () => {
    const pending = await member({ mustChangePassword: true });
    const anonymous = await app.inject({ method: "PATCH", url: "/api/profile/me/contacts", payload: { instagram: "x.ficticia" } });
    const blocked = await patchContacts(pending.auth, { instagram: "x.ficticia" });

    expect(anonymous.statusCode).toBe(401);
    expect(blocked.status).toBe(403);
    expect(errorCode(blocked.body)).toBe("PASSWORD_CHANGE_REQUIRED");
  });
});

describe("OwnProfile.phoneNeedsConfirmation", () => {
  it.each([
    ["a legacy free-form phone", "55 1234 5678", true],
    ["a 10-digit legacy phone (never guessed as +52)", "2025550147", true],
    ["an E.164 phone", "+525512345678", false],
    ["no phone", null, false]
  ])("is %s → %s", async (_label, phone, expected) => {
    const { auth } = await member({ profile: { phone } });
    const response = await app.inject({ method: "GET", url: "/api/profile/me", ...auth });
    const body = response.json<OwnProfile>();
    if (expected) expect(body.phoneNeedsConfirmation).toBe(true);
    else expect(body).not.toHaveProperty("phoneNeedsConfirmation");
  });

  it("goes away once the owner confirms the phone through the contacts route", async () => {
    const { auth } = await member({ profile: { phone: "55 1234 5678" } });
    const response = await patchContacts(auth, { phone: "+52 55 1234 5678" });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).not.toHaveProperty("phoneNeedsConfirmation");
  });
});

describe("directory contact card", () => {
  async function listedWithContacts(overrides: CreateUserOptions["profile"] = {}): Promise<TestUser> {
    return createUser({
      emailVerified: true,
      email: `prima-${Math.random().toString(36).slice(2, 10)}@example.com`,
      profile: {
        fullName: "Prima Contactos",
        phone: "+525550100101",
        whatsapp: "+12025550147",
        instagram: "prima.ficticia",
        facebook: "prima.ficticia",
        tiktok: "prima_ficticia",
        linkedin: "prima-ficticia",
        github: "prima-ficticia",
        website: "https://example.com/prima",
        ...overrides
      }
    });
  }

  it("shows only switched-on contacts, as server-built links, in list and detail; hidden ones are absent", async () => {
    const viewer = await member();
    const target = await listedWithContacts({ showPhone: true, contactVisibility: { instagram: true, website: true } });

    const detail = await app.inject({ method: "GET", url: `/api/directory/${target.id}`, ...viewer.auth });
    const list = await app.inject({ method: "GET", url: "/api/directory?q=Contactos", ...viewer.auth });

    const expected = [
      { kind: "phone", label: "Teléfono", href: "tel:+525550100101", display: "+525550100101" },
      { kind: "instagram", label: "Instagram", href: "https://instagram.com/prima.ficticia", display: "@prima.ficticia" },
      { kind: "website", label: "Sitio web", href: "https://example.com/prima", display: "example.com/prima" }
    ];
    expect(detail.json<DirectoryEntry>().contacts).toEqual(expected);
    expect(list.json<Page<DirectoryEntry>>().items[0]?.contacts).toEqual(expected);
    for (const body of [detail.body, list.body]) {
      expect(body).not.toContain("2025550147");
      expect(body).not.toContain("prima_ficticia");
      expect(body).not.toContain("github");
      expect(body).not.toContain(target.email);
      expect(body).not.toContain("contactVisibility");
    }
  });

  it("drops a legacy free-form phone from the card even when shown (no guessing)", async () => {
    const viewer = await member();
    const target = await listedWithContacts({ phone: "55 1234 5678", showPhone: true });
    const detail = await app.inject({ method: "GET", url: `/api/directory/${target.id}`, ...viewer.auth });
    expect(detail.json<DirectoryEntry>().contacts).toEqual([]);
  });

  it("gives an empty card when nothing is switched on, even with a corrupt-looking map", async () => {
    const viewer = await member();
    const target = await listedWithContacts({ contactVisibility: {} });
    const detail = await app.inject({ method: "GET", url: `/api/directory/${target.id}`, ...viewer.auth });
    expect(detail.json<DirectoryEntry>().contacts).toEqual([]);
  });

  it("never sends contacts to an unverified viewer, nor for unlisted or disabled accounts", async () => {
    const unverified = await createUser({ emailVerified: false });
    const unverifiedAuth = await bearerFor(unverified, await createSession(unverified.id));
    const viewer = await member();
    const all = { showEmail: true, showPhone: true, contactVisibility: { whatsapp: true, instagram: true, github: true } };
    const unlisted = await listedWithContacts({ ...all, listedInDirectory: false, instagram: "no.listada" });
    const disabled = await createUser({
      emailVerified: true,
      status: "disabled",
      profile: { fullName: "Baja Contactos", ...all, instagram: "dada.de.baja" }
    });
    const listed = await listedWithContacts({ ...all });

    const blocked = await app.inject({ method: "GET", url: `/api/directory/${listed.id}`, ...unverifiedAuth });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body).not.toContain("prima.ficticia");

    const bodies: string[] = [];
    for (const url of ["/api/directory", "/api/directory?q=ficticia", `/api/directory/${unlisted.id}`, `/api/directory/${disabled.id}`]) {
      bodies.push((await app.inject({ method: "GET", url, ...viewer.auth })).body);
    }
    const text = bodies.join("\n");
    expect(text).not.toContain("no.listada");
    expect(text).not.toContain("dada.de.baja");
    expect(text).not.toContain(unlisted.email);
  });

  it("is updated by the owner's PATCH and seen by another member", async () => {
    const owner = await member({ profile: { fullName: "Dueña Contactos" } });
    const viewer = await member();

    await patchContacts(owner.auth, { ...TYPED, visibility: { whatsapp: true, github: true, tiktok: true } });
    const detail = await app.inject({ method: "GET", url: `/api/directory/${owner.user.id}`, ...viewer.auth });

    expect(detail.json<DirectoryEntry>().contacts?.map((item) => item.kind)).toEqual(["whatsapp", "tiktok", "github"]);
    expect(detail.json<DirectoryEntry>().contacts?.[0]?.href).toBe("https://wa.me/12025550147");
  });
});
