import type { DirectoryEntry, Page } from "@cuencada/types";
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
import { people } from "../../db/schema/index.js";

let app: App;
let logs: string[];
let viewer: { user: TestUser; auth: AuthInjectOptions };

beforeEach(async () => {
  logs = [];
  app = await createTestApp({
    logStream: { write: (line) => logs.push(line) }
  });
  viewer = await member({
    displayName: "Visitante",
    profile: { fullName: "Zz Visitante" }
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

async function list(query = "", auth: AuthInjectOptions = viewer.auth): Promise<Page<DirectoryEntry>> {
  const response = await app.inject({
    method: "GET",
    url: `/api/directory${query}`,
    ...auth
  });
  expect(response.statusCode).toBe(200);
  return response.json<Page<DirectoryEntry>>();
}

function names(page: Page<DirectoryEntry>): string[] {
  return page.items.map((item) => item.fullName);
}

const CONTACT = { phone: "+52 999 123 4567", city: "Valladolid" } as const;

describe("GET /api/directory", () => {
  it("lists active members by name and omits hidden contact fields (absent, not null)", async () => {
    const ana = await createUser({
      displayName: "Ana",
      profile: { fullName: "Ana Cuenca", ...CONTACT }
    });
    await createUser({
      displayName: "Beto",
      profile: { fullName: "Beto Cuenca", showCity: true, city: "Mérida" }
    });
    await createUser({
      displayName: "Caro",
      status: "disabled",
      profile: { fullName: "Caro Cuenca", showPhone: true, phone: "+52 1" }
    });

    const page = await list();

    expect(names(page)).toEqual(["Ana Cuenca", "Beto Cuenca", "Zz Visitante"]);
    expect(page.nextCursor).toBeNull();
    const first = page.items[0];
    expect(first).toEqual({
      userId: ana.id,
      personId: null,
      displayName: "Ana",
      fullName: "Ana Cuenca",
      familyBranch: null,
      avatarUrl: null,
      bio: null
    });
    expect(first !== undefined && "phone" in first).toBe(false);
    expect(page.items[1]?.city).toBe("Mérida");
  });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [true, true, true]
  ])(
    "applies the visibility matrix email=%s phone=%s city=%s in list and detail",
    async (showEmail, showPhone, showCity) => {
      const target = await createUser({
        email: "prima@familia.test",
        profile: {
          fullName: "Prima Matriz",
          ...CONTACT,
          showEmail,
          showPhone,
          showCity
        }
      });
      const detail = await app.inject({
        method: "GET",
        url: `/api/directory/${target.id}`,
        ...viewer.auth
      });
      const fromList = (await list("?q=Prima")).items[0];

      expect(detail.statusCode).toBe(200);
      for (const entry of [detail.json<DirectoryEntry>(), fromList]) {
        expect(entry?.userId).toBe(target.id);
        expect(entry !== undefined && "email" in entry).toBe(showEmail);
        expect(entry !== undefined && "phone" in entry).toBe(showPhone);
        expect(entry !== undefined && "city" in entry).toBe(showCity);
        if (showEmail) expect(entry?.email).toBe("prima@familia.test");
        if (showPhone) expect(entry?.phone).toBe(CONTACT.phone);
        if (showCity) expect(entry?.city).toBe(CONTACT.city);
      }
      if (!showPhone) {
        expect(detail.body).not.toContain("123 4567");
        expect(JSON.stringify(fromList)).not.toContain("123 4567");
      }
      if (!showEmail) expect(detail.body).not.toContain("prima@familia.test");
    }
  );

  it("never matches a hidden phone, hidden city or any email/phone through search", async () => {
    await createUser({
      email: "oculto@familia.test",
      profile: {
        fullName: "Persona Oculta",
        phone: "+52 999 765 4321",
        city: "Tizimín",
        showPhone: false,
        showCity: false
      }
    });
    await createUser({
      email: "visible@familia.test",
      profile: {
        fullName: "Persona Visible",
        phone: "+52 999 111 2222",
        city: "Izamal",
        showPhone: true,
        showEmail: true,
        showCity: true
      }
    });

    for (const q of ["765", "4321", "Tizimín", "tizi", "oculto", "familia.test", "111 2222", "visible@"]) {
      const page = await list(`?q=${encodeURIComponent(q)}`);
      expect(names(page)).toEqual([]);
      expect(JSON.stringify(page)).not.toContain("765 4321");
    }
    expect(names(await list("?q=izamal"))).toEqual(["Persona Visible"]);
    expect(names(await list(`?city=${encodeURIComponent("Tizimín")}`))).toEqual([]);
    expect(names(await list("?city=IZAMAL"))).toEqual(["Persona Visible"]);
  });

  it("matches display name, full name, nickname and family branch, case-insensitively", async () => {
    const lupe = await createUser({
      displayName: "Tía Lupe",
      profile: { fullName: "Guadalupe Pérez", familyBranch: "Rama Norte" }
    });
    await getTestDb().insert(people).values({
      fullName: "Guadalupe Pérez",
      nickname: "La Güera",
      userId: lupe.id
    });
    await createUser({
      displayName: "Otro",
      profile: { fullName: "Otro Familiar", familyBranch: "Rama Sur" }
    });

    for (const q of ["tía", "GUADALUPE", "güera", "norte"]) {
      expect(names(await list(`?q=${encodeURIComponent(q)}`))).toEqual(["Guadalupe Pérez"]);
    }
    expect(names(await list(`?familyBranch=${encodeURIComponent("rama sur")}`))).toEqual(["Otro Familiar"]);
    expect(names(await list(`?q=${encodeURIComponent("   ")}`))).toHaveLength(3);
  });

  it("treats LIKE wildcards in q literally", async () => {
    await createUser({ profile: { fullName: "Ana 100% Cuenca" } });
    await createUser({ profile: { fullName: "Beto_Cuenca" } });
    await createUser({ profile: { fullName: "Carlos Cuenca" } });

    expect(names(await list("?q=%25"))).toEqual(["Ana 100% Cuenca"]);
    expect(names(await list("?q=_"))).toEqual(["Beto_Cuenca"]);
    expect(names(await list(`?q=${encodeURIComponent("\\")}`))).toEqual([]);
  });

  it("pages with a keyset cursor across tied names without duplicates or gaps", async () => {
    for (let index = 0; index < 5; index += 1)
      await createUser({
        profile: { fullName: index < 3 ? "Igual Nombre" : `Nombre ${index}` }
      });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const page = await list(query);
      seen.push(...page.items.map((item) => item.userId));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("uses an id-only cursor that never contains a name, even for very long names", async () => {
    for (const letter of ["a", "b", "c"])
      await createUser({ profile: { fullName: `${letter}${"ñ".repeat(150)} Secreto` } });

    const first = await list("?limit=1");
    const second = await list(`?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    const third = await list(`?limit=1&cursor=${encodeURIComponent(second.nextCursor ?? "")}`);

    expect([...names(first), ...names(second), ...names(third)].map((name) => name[0])).toEqual(["a", "b", "c"]);
    for (const [page, cursor] of [
      [first, first.nextCursor],
      [second, second.nextCursor]
    ] as const) {
      const decoded = Buffer.from(cursor ?? "", "base64url").toString("utf8");
      expect(decoded).toBe(page.items[0]?.userId);
      expect(decoded).not.toContain("ñ");
      expect(decoded.toLowerCase()).not.toContain("secreto");
    }
  });

  it("answers the same generic 400 for a cursor at an unlisted, disabled or unknown user", async () => {
    const hidden = await createUser({ profile: { fullName: "Oculto", listedInDirectory: false } });
    const disabled = await createUser({ status: "disabled", profile: { fullName: "Baja" } });
    const ids = [hidden.id, disabled.id, "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e"];

    const responses = await Promise.all(
      ids.map((id) =>
        app.inject({
          method: "GET",
          url: `/api/directory?cursor=${Buffer.from(id).toString("base64url")}`,
          ...viewer.auth
        })
      )
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(response.body).toBe(responses[2]?.body);
    }
    expect(responses[0]?.json()).toEqual({
      error: {
        code: "VALIDATION",
        message: "Cursor inválido.",
        details: [{ path: "cursor", message: "Cursor inválido." }]
      }
    });
  });

  it.each([
    ["a forged cursor", "?cursor=bm90LWEtY3Vyc29y"],
    ["a cursor that is not a uuid", `?cursor=${Buffer.from("x:abc").toString("base64url")}`],
    [
      "an old name cursor",
      `?cursor=n.${Buffer.from("1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e:ana").toString("base64url")}`
    ],
    ["q over 100 characters", `?q=${"a".repeat(101)}`],
    ["a limit over 100", "?limit=101"]
  ])("answers 400 for %s", async (_label, query) => {
    const response = await app.inject({
      method: "GET",
      url: `/api/directory${query}`,
      ...viewer.auth
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response.body)).toBe("VALIDATION");
  });

  it("answers 401 without a token, 403 for an unverified member and 403 while a password change is pending", async () => {
    const unverified = await member({ emailVerified: false });
    const pending = await member({ mustChangePassword: true });

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/directory"
    });
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/directory",
      ...unverified.auth
    });
    const mustChange = await app.inject({
      method: "GET",
      url: "/api/directory",
      ...pending.auth
    });

    expect(anonymous.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    expect(errorCode(forbidden.body)).toBe("FORBIDDEN");
    expect(mustChange.statusCode).toBe(403);
  });

  it("presigns avatars in entries", async () => {
    const userId = "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";
    const uploadId = "2c3d4e5f-6071-4c8d-9e0f-1a2b3c4d5e6f";
    await createUser({
      profile: {
        fullName: "Con Foto",
        avatarKey: `avatars/${userId}/${uploadId}-256.webp`
      }
    });
    await createUser({
      profile: {
        fullName: "Con Legado",
        avatarKey: "https://legacy.example.com/a.jpg"
      }
    });

    const page = await list("?q=con");

    expect(page.items[0]?.avatarUrl).toContain(`${uploadId}-256.webp`);
    expect(page.items[1]?.avatarUrl).toBeNull();
  });

  it("rate-limits search to 60 per minute per user", async () => {
    const other = await member();
    for (let index = 0; index < 60; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/directory?limit=1",
        ...viewer.auth
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "GET",
      url: "/api/directory?limit=1",
      ...viewer.auth
    });
    expect(limited.statusCode).toBe(429);
    expect(errorCode(limited.body)).toBe("RATE_LIMITED");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/directory?limit=1",
          ...other.auth
        })
      ).statusCode
    ).toBe(200);
  });

  it("logs no contact data of listed members", async () => {
    const target = await createUser({
      email: "secreto@familia.test",
      profile: {
        fullName: "Pariente Discreto",
        phone: "+52 999 404 0404",
        city: "Hunucmá",
        bio: "Biografía privada",
        showPhone: true
      }
    });
    await list();
    await list(`?q=${encodeURIComponent("Pariente Discreto")}`);
    await app.inject({
      method: "GET",
      url: `/api/directory/${target.id}`,
      ...viewer.auth
    });

    const output = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(output).not.toContain("404 0404");
    expect(output).not.toContain("secreto@familia.test");
    expect(output).not.toContain("Hunucmá");
    expect(output).not.toContain("Biografía privada");
    // The search term is scrubbed from the logged request URL.
    expect(output).toContain("/api/directory");
    expect(output).not.toContain("Pariente");
    expect(output).not.toContain("Discreto");
  });
});

describe("GET /api/directory/:id", () => {
  it("returns a listed member and 404 for disabled or unknown users", async () => {
    const listed = await createUser({ profile: { fullName: "Listado" } });
    const disabled = await createUser({
      status: "disabled",
      profile: { fullName: "Dado de baja" }
    });

    const ok = await app.inject({
      method: "GET",
      url: `/api/directory/${listed.id}`,
      ...viewer.auth
    });
    const gone = await app.inject({
      method: "GET",
      url: `/api/directory/${disabled.id}`,
      ...viewer.auth
    });
    const unknown = await app.inject({
      method: "GET",
      url: "/api/directory/1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e",
      ...viewer.auth
    });

    expect(ok.statusCode).toBe(200);
    expect(ok.json<DirectoryEntry>().fullName).toBe("Listado");
    expect(gone.statusCode).toBe(404);
    expect(gone.body).not.toContain("Dado de baja");
    expect(unknown.statusCode).toBe(404);
  });

  it("answers 400 for a malformed id, 401 without a token and 403 for an unverified member", async () => {
    const target = await createUser();
    const unverified = await member({ emailVerified: false });

    const malformed = await app.inject({
      method: "GET",
      url: "/api/directory/not-a-uuid",
      ...viewer.auth
    });
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/directory/${target.id}`
    });
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/directory/${target.id}`,
      ...unverified.auth
    });

    expect(malformed.statusCode).toBe(400);
    expect(anonymous.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
  });
});

describe("unlisted members (profiles.listed_in_directory)", () => {
  async function unlisted(): Promise<TestUser> {
    return createUser({
      email: "oculta@familia.test",
      displayName: "Prima Oculta",
      profile: {
        fullName: "Prima Oculta",
        familyBranch: "Rama Este",
        city: "Motul",
        phone: "+52 999 303 0303",
        showEmail: true,
        showPhone: true,
        showCity: true,
        listedInDirectory: false
      }
    });
  }

  it("excludes members with listed_in_directory = false from the list, q search and familyBranch/city filters", async () => {
    await unlisted();
    await createUser({
      profile: { fullName: "Primo Listado", familyBranch: "Rama Este", city: "Motul", showCity: true }
    });

    expect(names(await list())).toEqual(["Primo Listado", "Zz Visitante"]);
    for (const query of ["?q=Oculta", "?q=prima", `?familyBranch=${encodeURIComponent("Rama Este")}`, "?city=Motul"]) {
      expect(names(await list(query))).not.toContain("Prima Oculta");
    }
    expect(names(await list("?city=Motul"))).toEqual(["Primo Listado"]);
  });

  it("answers 404 for an unlisted member's detail, like a disabled one", async () => {
    const target = await unlisted();
    const response = await app.inject({ method: "GET", url: `/api/directory/${target.id}`, ...viewer.auth });
    expect(response.statusCode).toBe(404);
    expect(errorCode(response.body)).toBe("NOT_FOUND");
    expect(response.body).not.toContain("Prima Oculta");
  });

  it("never leaks an unlisted member's contact fields, even with every show* flag on", async () => {
    const target = await unlisted();
    const bodies: string[] = [];
    for (const url of [
      "/api/directory",
      "/api/directory?q=303",
      "/api/directory?q=Motul",
      `/api/directory/${target.id}`
    ]) {
      bodies.push((await app.inject({ method: "GET", url, ...viewer.auth })).body);
    }
    const all = bodies.join("\n");
    expect(all).not.toContain("303 0303");
    expect(all).not.toContain("oculta@familia.test");
    expect(all).not.toContain(target.id);
  });

  it("lists a member again after they opt back in", async () => {
    const target = await unlisted();
    const auth = await bearerFor(target, await createSession(target.id));
    expect(names(await list("?q=Oculta"))).toEqual([]);

    const toggled = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      ...auth,
      payload: { listedInDirectory: true }
    });

    expect(toggled.statusCode).toBe(200);
    expect(names(await list("?q=Oculta"))).toEqual(["Prima Oculta"]);
    const detail = await app.inject({ method: "GET", url: `/api/directory/${target.id}`, ...viewer.auth });
    expect(detail.statusCode).toBe(200);
  });
});
