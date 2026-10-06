import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { linkToken, loginFull, TestClock } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { magicLinks } from "../../db/schema/index.js";
import { type ResendEmailsClient, ResendMailer } from "../../lib/mailer/resend.js";
import { GLOBAL_DAILY_MAIL_CAP, RECIPIENT_MAIL_BUDGET, RESERVED_DAILY_MAIL_EXTRA } from "./mailBudget.js";
import { enqueueMail, MAIL_QUEUE_MAX_PENDING, mailQueue } from "./mailQueue.js";

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const MINUTE = 60_000;

async function post(instance: App, url: string, email: string, ip?: string): Promise<{ statusCode: number; body: string }> {
  const response = await instance.inject({
    method: "POST",
    url,
    payload: { email },
    ...(ip === undefined ? {} : { headers: { "x-forwarded-for": ip } })
  });
  return { statusCode: response.statusCode, body: response.body };
}

const MAGIC = "/api/auth/magic-link/request";
const RESET = "/api/auth/password-reset/request";

/** Insert `count` magic-link rows for other addresses, created now (fills the global cap). */
async function fillDailyCount(count: number): Promise<void> {
  const now = new Date();
  const rows = Array.from({ length: count }, () => ({
    email: `relleno-${randomUUID()}@example.test`,
    tokenHash: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    purpose: "login" as const,
    expiresAt: new Date(now.getTime() + 15 * MINUTE),
    createdAt: now
  }));
  for (let index = 0; index < rows.length; index += 200) {
    await getTestDb().insert(magicLinks).values(rows.slice(index, index + 200));
  }
}

describe("per-recipient email budget (Security M1)", () => {
  it("delivers at most 3 emails for 40 mixed requests from 40 IPs, answering only generic 202/429", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer, config: { TRUST_PROXY: ["loopback"] } });
    const victim = await createUser();

    const results: Array<{ statusCode: number; body: string }> = [];
    for (let index = 0; index < 40; index += 1) {
      results.push(await post(app, index % 2 === 0 ? MAGIC : RESET, victim.email, `198.51.100.${index + 1}`));
    }
    await mailQueue(app).onIdle();

    // The per-email request limiter (10 / 15 min per endpoint) answers 429 past it, the
    // same way for every address, so nothing is revealed; everything before it is 202.
    expect(results.slice(0, 20).every((result) => result.statusCode === 202)).toBe(true);
    expect(results.every((result) => result.statusCode === 202 || result.statusCode === 429)).toBe(true);
    expect(new Set(results.filter((r) => r.statusCode === 202).map((r) => r.body))).toEqual(new Set(['{"ok":true}']));
    const delivered = mailer.outbox.filter((mail) => mail.to === victim.email);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThanOrEqual(RECIPIENT_MAIL_BUDGET.perHour);
    // Skipped requests create no token rows either.
    const rows = await getTestDb().select().from(magicLinks).where(eq(magicLinks.email, victim.email));
    expect(rows).toHaveLength(delivered.length);
  });

  it("enforces one per purpose per 2 minutes and 3 per hour, then recovers after an hour", async () => {
    const mailer = new FakeMailer();
    const clock = new TestClock();
    app = await createTestApp({ mailer, clock });
    const user = await createUser();

    await post(app, MAGIC, user.email);
    await post(app, MAGIC, user.email); // same purpose within 2 min: skipped
    clock.advance(3 * MINUTE);
    await post(app, MAGIC, user.email);
    clock.advance(3 * MINUTE);
    await post(app, RESET, user.email);
    clock.advance(3 * MINUTE);
    await post(app, MAGIC, user.email); // 4th in the hour: skipped
    await mailQueue(app).onIdle();
    expect(mailer.outbox).toHaveLength(3);

    clock.advance(61 * MINUTE);
    await post(app, MAGIC, user.email);
    await mailQueue(app).onIdle();
    expect(mailer.outbox).toHaveLength(4);
  });

  it("caps one recipient at 10 per 24 hours across purposes", async () => {
    const mailer = new FakeMailer();
    const clock = new TestClock();
    app = await createTestApp({ mailer, clock });
    const user = await createUser();

    for (let index = 0; index < 12; index += 1) {
      await post(app, index % 2 === 0 ? MAGIC : RESET, user.email);
      clock.advance(61 * MINUTE);
    }
    await mailQueue(app).onIdle();

    expect(mailer.outbox).toHaveLength(RECIPIENT_MAIL_BUDGET.perDay);
  });

  it("counts verify-email requests in the same budget", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser();
    const login = await loginFull(app, user);

    await post(app, MAGIC, user.email);
    await app.inject({ method: "POST", url: "/api/auth/email/verify-request", ...login.auth });
    await post(app, RESET, user.email);
    await app.inject({ method: "POST", url: "/api/auth/email/verify-request", ...login.auth });
    await mailQueue(app).onIdle();

    expect(mailer.outbox.map((mail) => mail.tags?.category)).toEqual(["magic-link", "verify-email", "password-reset"]);
  });
});

describe("global daily email cap", () => {
  it("skips user-triggered emails at the cap, keeps a reserve for invites and warns once", async () => {
    const mailer = new FakeMailer();
    const lines: string[] = [];
    app = await createTestApp({ mailer, logStream: { write: (line) => lines.push(line) } });
    const first = await createUser();
    const second = await createUser();
    const admin = await createUser({ role: "admin" });
    const adminAuth = (await loginFull(app, admin)).auth;
    await fillDailyCount(GLOBAL_DAILY_MAIL_CAP);

    const responses = [await post(app, MAGIC, first.email), await post(app, RESET, second.email)];
    await mailQueue(app).onIdle();
    const invited = await app.inject({
      method: "POST",
      url: "/api/admin/invites",
      payload: { email: "reserva@familia.mx" },
      ...adminAuth
    });

    expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
    expect(mailer.outbox.map((mail) => mail.to)).toEqual(["reserva@familia.mx"]);
    expect(invited.statusCode).toBe(201);
    const warnings = lines.filter((line) => line.includes('"mail.cap_reached"'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(first.email);

    await fillDailyCount(RESERVED_DAILY_MAIL_EXTRA);
    const refused = await app.inject({
      method: "POST",
      url: "/api/admin/invites",
      payload: { email: "sin-cupo@familia.mx" },
      ...adminAuth
    });
    expect(refused.statusCode).toBe(503);
    expect(mailer.lastTo("sin-cupo@familia.mx")).toBeUndefined();
  });
});

describe("mail queue", () => {
  it(`drops sends past ${MAIL_QUEUE_MAX_PENDING} pending with a warning`, async () => {
    const lines: string[] = [];
    app = await createTestApp({ logStream: { write: (line) => lines.push(line) } });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mailQueue(app).enqueue("test.hold", () => held);
    await Promise.resolve();

    const accepted: boolean[] = [];
    for (let index = 0; index <= MAIL_QUEUE_MAX_PENDING; index += 1) {
      accepted.push(enqueueMail(app, "test.noop", async () => {}));
    }

    expect(accepted.slice(0, MAIL_QUEUE_MAX_PENDING).every(Boolean)).toBe(true);
    expect(accepted.at(-1)).toBe(false);
    expect(lines.some((line) => line.includes('"mail.queue_full"'))).toBe(true);
    release();
    await mailQueue(app).onIdle();
  });

  function stubResend(errors: Array<string | null>): { client: ResendEmailsClient; keys: Array<string | undefined> } {
    const keys: Array<string | undefined> = [];
    const send = async (_payload: unknown, options?: { idempotencyKey?: string }) => {
      keys.push(options?.idempotencyKey);
      const name = errors.shift() ?? null;
      return name === null
        ? { data: { id: `resend-${keys.length}` }, error: null, headers: null }
        : { data: null, error: { name, message: "stub", statusCode: 429 }, headers: null };
    };
    // The stub implements only what ResendMailer reads ({ data, error }); the SDK's
    // full response types carry fields this class never touches.
    return { client: { send } as unknown as ResendEmailsClient, keys };
  }

  it("retries a provider rate limit with the same idempotency key, then succeeds", async () => {
    const stub = stubResend(["rate_limit_exceeded", null]);
    const mailer = new ResendMailer({ apiKey: "re_test", from: "Cuencada <no-reply@example.test>" }, stub.client);
    app = await createTestApp({ mailer });
    const user = await createUser();

    await post(app, MAGIC, user.email);
    await mailQueue(app).onIdle();

    expect(stub.keys).toHaveLength(2);
    expect(stub.keys[0]).toMatch(/^magic-link:/);
    expect(stub.keys[1]).toBe(stub.keys[0]);
  });

  it("does not retry a validation error and logs the failure without PII", async () => {
    const lines: string[] = [];
    const stub = stubResend(["validation_error"]);
    const mailer = new ResendMailer({ apiKey: "re_test", from: "Cuencada <no-reply@example.test>" }, stub.client);
    app = await createTestApp({ mailer, logStream: { write: (line) => lines.push(line) } });
    const user = await createUser();

    await post(app, MAGIC, user.email);
    await mailQueue(app).onIdle();

    expect(stub.keys).toHaveLength(1);
    const failure = lines.find((line) => line.includes("job failed"));
    expect(failure).toBeDefined();
    expect(failure).not.toContain(user.email);
  });
});

describe("pending email tokens are burned (Security L3)", () => {
  it("change-password burns pending login and verify links", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser();
    const login = await loginFull(app, user);
    await post(app, MAGIC, user.email);
    await app.inject({ method: "POST", url: "/api/auth/email/verify-request", ...login.auth });
    await mailQueue(app).onIdle();
    const [magicMail, verifyMail] = mailer.outbox;

    await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: user.password, newPassword: "otra-contraseña-larga" },
      ...login.auth
    });

    const magic = await app.inject({ method: "POST", url: "/api/auth/magic-link/consume", payload: { token: linkToken(magicMail) } });
    const verify = await app.inject({ method: "POST", url: "/api/auth/email/verify", payload: { token: linkToken(verifyMail) } });
    expect(magic.statusCode).toBe(400);
    expect(verify.statusCode).toBe(400);
  });

  it("reset confirm burns a pending magic link", async () => {
    const mailer = new FakeMailer();
    const clock = new TestClock();
    app = await createTestApp({ mailer, clock });
    const user = await createUser();
    await post(app, MAGIC, user.email);
    clock.advance(3 * MINUTE);
    await post(app, RESET, user.email);
    await mailQueue(app).onIdle();
    const [magicMail, resetMail] = mailer.outbox;

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/confirm",
      payload: { token: linkToken(resetMail), newPassword: "otra-contraseña-larga" }
    });
    const magic = await app.inject({ method: "POST", url: "/api/auth/magic-link/consume", payload: { token: linkToken(magicMail) } });

    expect(confirmed.statusCode).toBe(204);
    expect(magic.statusCode).toBe(400);
  });
});
