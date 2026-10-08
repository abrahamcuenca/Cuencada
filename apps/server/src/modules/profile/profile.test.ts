import type { OwnProfile } from "@cuencada/types";
import { eq } from "drizzle-orm";
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
import { auditLogs, people, profiles, users } from "../../db/schema/index.js";

let app: App;
let logs: string[];

beforeEach(async () => {
  logs = [];
  app = await createTestApp({
    logStream: { write: (line) => logs.push(line) }
  });
});

afterEach(async () => {
  await app.close();
});

async function member(options: CreateUserOptions = {}): Promise<{ user: TestUser; auth: AuthInjectOptions }> {
  const user = await createUser({ emailVerified: true, ...options });
  return { user, auth: await bearerFor(user, await createSession(user.id)) };
}

function errorCode(body: string): string {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
    const error: unknown = parsed.error;
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string")
      return error.code;
  }
  return "";
}

describe("GET /api/profile/me", () => {
  it("returns the full own profile including hidden fields and visibility flags", async () => {
    const { user, auth } = await member({
      displayName: "Ana",
      profile: {
        fullName: "Ana Morales",
        phone: "+52 555 012 4567",
        city: "Mérida",
        bio: "Hola",
        showPhone: false
      }
    });
    const [person] = await getTestDb().insert(people).values({ fullName: "Ana Morales", userId: user.id }).returning();

    const response = await app.inject({
      method: "GET",
      url: "/api/profile/me",
      ...auth
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<OwnProfile>();
    expect(body).toEqual({
      userId: user.id,
      personId: person?.id,
      email: user.email,
      displayName: "Ana",
      fullName: "Ana Morales",
      familyBranch: null,
      city: "Mérida",
      phone: "+52 555 012 4567",
      bio: "Hola",
      avatarUrl: null,
      visibility: { showEmail: false, showPhone: false, showCity: false, listedInDirectory: true },
      contacts: {
        whatsapp: null,
        instagram: null,
        facebook: null,
        tiktok: null,
        linkedin: null,
        github: null,
        website: null,
        visibility: {
          email: false,
          phone: false,
          whatsapp: false,
          instagram: false,
          facebook: false,
          tiktok: false,
          linkedin: false,
          github: false,
          website: false
        }
      },
      // The legacy free-form phone is not E.164: the owner is asked to confirm it.
      phoneNeedsConfirmation: true,
      updatedAt: user.profile.updatedAt.toISOString()
    });
  });

  it("is allowed while the email is unverified", async () => {
    const { auth } = await member({ emailVerified: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/profile/me",
      ...auth
    });
    expect(response.statusCode).toBe(200);
  });

  it("answers 403 while a password change is pending and 401 without a token", async () => {
    const { auth } = await member({ mustChangePassword: true });
    const pending = await app.inject({
      method: "GET",
      url: "/api/profile/me",
      ...auth
    });
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/profile/me"
    });

    expect(pending.statusCode).toBe(403);
    expect(errorCode(pending.body)).toBe("PASSWORD_CHANGE_REQUIRED");
    expect(anonymous.statusCode).toBe(401);
  });

  it("creates a missing profile row from the display name", async () => {
    const { user, auth } = await member({ displayName: "Sin Perfil" });
    await getTestDb().delete(profiles).where(eq(profiles.userId, user.id));

    const response = await app.inject({
      method: "GET",
      url: "/api/profile/me",
      ...auth
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<OwnProfile>().fullName).toBe("Sin Perfil");
  });
});

describe("PATCH /api/profile/me", () => {
  it("updates fields and flags, syncs users.display_name and audits field names only", async () => {
    const { user, auth } = await member();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      ...auth,
      payload: {
        displayName: "Tía Lupe",
        fullName: "Guadalupe Morales",
        phone: "+52 (999) 555-0101",
        city: "Mérida",
        bio: "Me encanta la cochinita.",
        familyBranch: "Rama Norte",
        showPhone: true,
        showCity: true
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<OwnProfile>();
    expect(body).toMatchObject({
      displayName: "Tía Lupe",
      fullName: "Guadalupe Morales",
      phone: "+529995550101", // normalized to E.164 (WP-4.0)
      city: "Mérida",
      familyBranch: "Rama Norte",
      visibility: { showEmail: false, showPhone: true, showCity: true }
    });
    const [account] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(account?.displayName).toBe("Tía Lupe");

    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "profile.updated"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: user.id,
      entityType: "profile",
      entityId: user.profile.id
    });
    expect(audits[0]?.metadata).toEqual({
      fields: ["bio", "city", "displayName", "familyBranch", "fullName", "phone", "showCity", "showPhone"]
    });
    const auditJson = JSON.stringify(audits);
    expect(auditJson).not.toContain("555-0101");
    expect(auditJson).not.toContain("cochinita");
  });

  it("clears optional fields with null or blanks and leaves omitted fields alone", async () => {
    const { auth } = await member({
      profile: {
        fullName: "Ana",
        city: "Mérida",
        phone: "+52 555 012 4567",
        bio: "Hola"
      }
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      ...auth,
      payload: { city: "   ", phone: null }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<OwnProfile>()).toMatchObject({
      city: null,
      phone: null,
      bio: "Hola",
      fullName: "Ana"
    });
  });

  it.each([
    ["role", { role: "admin" }],
    ["status", { status: "disabled" }],
    ["userId", { userId: "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e" }],
    ["email", { email: "otro@example.test" }],
    ["avatarKey", { avatarKey: "avatars/x/y-256.webp" }],
    ["mustChangePassword", { mustChangePassword: false }]
  ])("rejects mass assignment of %s with 400 and changes nothing", async (_key, extra) => {
    const { user, auth } = await member({
      profile: { fullName: "Original" }
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      ...auth,
      payload: { fullName: "Cambiado", ...extra }
    });

    expect(response.statusCode).toBe(400);
    expect(errorCode(response.body)).toBe("VALIDATION");
    const [account] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    const [profile] = await getTestDb().select().from(profiles).where(eq(profiles.userId, user.id));
    expect(account).toMatchObject({
      role: "member",
      status: "active",
      email: user.email
    });
    expect(profile).toMatchObject({ fullName: "Original", avatarKey: null });
  });

  it.each([
    ["an invalid phone", { phone: "llámame al rato" }],
    ["a phone with too many digits", { phone: "+1234567890123456" }],
    ["a bio over 500 characters", { bio: "a".repeat(501) }],
    ["a blank full name", { fullName: "   " }],
    ["a display name with bidi controls", { displayName: "Ana\u202E" }],
    ["an empty patch", {}],
    ["a non-boolean flag", { showPhone: "yes" }]
  ])("answers 400 for %s", async (_label, payload) => {
    const { auth } = await member();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      ...auth,
      payload
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response.body)).toBe("VALIDATION");
  });

  it("answers 401 without a token and 403 while a password change is pending", async () => {
    const { auth } = await member({ mustChangePassword: true });
    const anonymous = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      payload: { bio: "x" }
    });
    const pending = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      ...auth,
      payload: { bio: "x" }
    });
    expect(anonymous.statusCode).toBe(401);
    expect(pending.statusCode).toBe(403);
  });

  it("never writes profile values to the logs", async () => {
    const { auth } = await member();
    await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      ...auth,
      payload: {
        phone: "+52 555 077 8888",
        bio: "Secreto de familia",
        city: "Progreso"
      }
    });
    await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      ...auth,
      payload: { phone: "+52 555 077 8888", role: "admin" }
    });
    await app.inject({ method: "GET", url: "/api/profile/me", ...auth });

    const output = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(output).not.toContain("777 8888");
    expect(output).not.toContain("Secreto de familia");
    expect(output).not.toContain("Progreso");
  });
});

describe("listed in directory (profiles.listed_in_directory)", () => {
  it("returns visibility.listedInDirectory (default true) in GET /api/profile/me", async () => {
    const { auth } = await member();
    const { auth: hiddenAuth } = await member({ profile: { fullName: "Oculta", listedInDirectory: false } });

    const listed = await app.inject({ method: "GET", url: "/api/profile/me", ...auth });
    const hidden = await app.inject({ method: "GET", url: "/api/profile/me", ...hiddenAuth });

    expect(listed.json<OwnProfile>().visibility.listedInDirectory).toBe(true);
    expect(hidden.json<OwnProfile>().visibility.listedInDirectory).toBe(false);
  });

  it("lets PATCH toggle listedInDirectory and audits only the field name", async () => {
    const { user, auth } = await member();

    const off = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      ...auth,
      payload: { listedInDirectory: false }
    });

    expect(off.statusCode).toBe(200);
    expect(off.json<OwnProfile>().visibility.listedInDirectory).toBe(false);
    const [profile] = await getTestDb().select().from(profiles).where(eq(profiles.userId, user.id));
    expect(profile?.listedInDirectory).toBe(false);
    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "profile.updated"));
    expect(audit?.metadata).toEqual({ fields: ["listedInDirectory"] });

    const bad = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      ...auth,
      payload: { listedInDirectory: "no" }
    });
    expect(bad.statusCode).toBe(400);
  });
});
