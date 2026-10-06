import { afterAll, beforeAll, beforeEach } from "vitest";
import { closeTestDb, ensureWorkerDatabase, resetDb } from "./helpers/db.js";

// Per-file setup for the server project: make sure this worker has its own
// cloned database, start every test from empty tables, and release the
// connection pool when the file finishes.

beforeAll(async () => {
  await ensureWorkerDatabase();
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});
