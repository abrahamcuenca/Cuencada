import { describe, expect, it } from "vitest";
import { profiles, users } from "../../src/db/schema.js";
import { workerDatabaseName } from "../env.js";
import { getTestDb, resetDb } from "./db.js";
import { createUser } from "./factories.js";

describe("getTestDb", () => {
  it("connects to the current worker's cloned database", async () => {
    const rows = await getTestDb().$client<{ name: string }[]>`select current_database() as name`;

    expect(rows[0]?.name).toBe(workerDatabaseName());
  });
});

describe("resetDb", () => {
  it("empties application tables but keeps the migrations journal", async () => {
    await createUser();
    expect(await getTestDb().$count(users)).toBe(1);

    await resetDb();

    const db = getTestDb();
    expect(await db.$count(users)).toBe(0);
    expect(await db.$count(profiles)).toBe(0);
    const migrations = await db.$client<{ count: number }[]>`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `;
    expect(migrations[0]?.count).toBeGreaterThan(0);
  });
});
