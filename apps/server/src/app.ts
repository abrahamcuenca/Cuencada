/**
 * Fastify application factory. FROZEN after WP-0.4: Phase-1 tracks add routes
 * in `src/modules/<m>/index.ts` only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { healthResponseSchema, WS_MAX_FRAME_BYTES } from "@cuencada/types";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type RawServerDefault } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppConfig, TrustProxySetting } from "./config.js";
import { createDatabase, type Database } from "./db/client.js";
import { type LogStream, loggerOptions } from "./logging.js";
import { type BreachedPasswordChecker, createBreachedPasswordChecker, type RangeFetcher } from "./lib/breachedPasswords.js";
import { type Clock, systemClock } from "./lib/clock.js";
import { AppError } from "./lib/errors.js";
import { createJobQueue, type JobQueue } from "./lib/jobs.js";
import { createMailer } from "./lib/mailer/index.js";
import type { Mailer } from "./lib/mailer/types.js";
import { GLOBAL_RATE_LIMIT, ipKey, rateLimitByIp } from "./lib/rateLimit.js";
import { S3Storage } from "./lib/storage/s3.js";
import type { StorageService } from "./lib/storage/types.js";
import adminModule from "./modules/admin/index.js";
import announcementsModule from "./modules/announcements/index.js";
import authModule from "./modules/auth/index.js";
import chatModule from "./modules/chat/index.js";
import cuencadasModule from "./modules/cuencadas/index.js";
import directoryModule from "./modules/directory/index.js";
import familyModule from "./modules/family/index.js";
import invitesModule from "./modules/invites/index.js";
import mediaModule from "./modules/media/index.js";
import profileModule from "./modules/profile/index.js";
import rsvpModule from "./modules/rsvp/index.js";
import { registerAuthGuard } from "./plugins/auth.js";
import { registerErrorHandling } from "./plugins/errors.js";
import { registerSecurity } from "./plugins/security.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
    mailer: Mailer;
    storage: StorageService;
    clock: Clock;
    jobs: JobQueue;
    /** Breached-password check (HIBP k-anonymity); `skipped` when `PASSWORD_BREACH_CHECK=off`. */
    breachedPasswords: BreachedPasswordChecker;
  }
}

/** The app instance with the zod type provider. */
export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** Injectable dependencies; anything omitted is created from `config`. */
export interface AppDeps {
  /** Database client. An injected client is **not** closed by the app. */
  db?: Database;
  mailer?: Mailer;
  storage?: StorageService;
  clock?: Clock;
  /** Capture logs (tests). Without it, tests log nothing. */
  logStream?: LogStream;
  /** HIBP range fetcher (tests inject a fake; production uses the global `fetch`). */
  breachFetcher?: RangeFetcher;
}

const SERVICE_NAME = "cuencada-api";

/** Fastify's types lack the numeric hop-count form, so express it as a function. */
function fastifyTrustProxy(
  setting: TrustProxySetting
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof setting === "number") return (_address, hop) => hop < setting;
  return setting;
}
const READY_DB_TIMEOUT_MS = 2000;
/** `/health/ready` reuses a DB ping result for this long, so probes cannot amplify into DB load. */
export const READY_CACHE_MS = 5000;

// Spanish default messages for every zod schema (ADR 0001 §4). Contract
// schemas keep their own custom messages; this covers zod's defaults. Runs
// once, when the server module is first imported.
z.config(z.locales.es());

/** Resources `buildApp` created itself and must release on close or on a failed build. */
interface OwnedResources {
  closeDb: (() => Promise<void>) | null;
  s3: S3Storage | null;
  jobs: JobQueue | null;
}

async function releaseOwned(owned: OwnedResources): Promise<void> {
  await owned.jobs?.close();
  owned.s3?.destroy();
  // postgres-js `end()` is idempotent, so a second call (onClose after a failed build) is harmless.
  if (owned.closeDb !== null) await owned.closeDb();
}

async function pingDatabase(db: Database): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), READY_DB_TIMEOUT_MS);
  });
  try {
    const ping = db.$client`select 1`.then(() => true);
    return await Promise.race([ping, timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the API: plugins, security, auth guard, error handling, health checks
 * and every module under `/api`.
 *
 * @param config - Validated config (see `loadConfig`).
 * @param deps - Optional injected services (tests pass fakes).
 * @returns A Fastify instance that is not yet listening. `close()` releases
 *          the DB pool (if the app created it), storage client and job queue.
 */
export async function buildApp(config: AppConfig, deps: AppDeps = {}): Promise<App> {
  const app = Fastify({
    logger: loggerOptions(config, deps.logStream === undefined ? {} : { stream: deps.logStream }),
    trustProxy: fastifyTrustProxy(config.TRUST_PROXY),
    // Never trust a client-supplied request id.
    requestIdHeader: false
  }).withTypeProvider<ZodTypeProvider>();

  const owned: OwnedResources = { closeDb: null, s3: null, jobs: null };
  try {
    await configureApp(app, config, deps, owned);
    return app;
  } catch (error) {
    // Do not leak the pool (or S3 sockets) when construction fails partway.
    await releaseOwned(owned);
    throw error;
  }
}

async function configureApp(app: App, config: AppConfig, deps: AppDeps, owned: OwnedResources): Promise<void> {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Services the app creates itself are released on close; injected ones belong to the caller.
  const clock = deps.clock ?? systemClock;
  let db: Database;
  if (deps.db === undefined) {
    const created = createDatabase(config);
    owned.closeDb = created.close;
    db = created;
  } else {
    db = deps.db;
  }
  let storage: StorageService;
  if (deps.storage === undefined) {
    owned.s3 = new S3Storage(config, clock);
    storage = owned.s3;
  } else {
    storage = deps.storage;
  }
  owned.jobs = createJobQueue(app.log);

  app.decorate("config", config);
  app.decorate("db", db);
  app.decorate("clock", clock);
  app.decorate("storage", storage);
  app.decorate("jobs", owned.jobs);
  app.addHook("onClose", async () => {
    await releaseOwned(owned);
  });
  app.decorate("mailer", deps.mailer ?? createMailer(config, app.log));
  app.decorate(
    "breachedPasswords",
    createBreachedPasswordChecker({
      enabled: config.PASSWORD_BREACH_CHECK === "on",
      minCount: config.PASSWORD_BREACH_MIN_COUNT,
      logger: app.log,
      ...(deps.breachFetcher === undefined ? {} : { fetcher: deps.breachFetcher })
    })
  );

  await registerSecurity(app);
  await app.register(rateLimit, {
    ...GLOBAL_RATE_LIMIT,
    keyGenerator: ipKey,
    errorResponseBuilder: () => new AppError("RATE_LIMITED")
  });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: WS_MAX_FRAME_BYTES } });

  registerErrorHandling(app);
  registerAuthGuard(app);

  app.get("/health", { config: { auth: "public", rateLimit: false } }, async () => ({
    ok: true,
    service: SERVICE_NAME
  }));

  let readyCache: { at: number; ok: boolean } | null = null;
  let readyInFlight: Promise<boolean> | null = null;
  const readiness = (): Promise<boolean> => {
    const now = app.clock.now().getTime();
    if (readyCache !== null && now - readyCache.at < READY_CACHE_MS) return Promise.resolve(readyCache.ok);
    readyInFlight ??= pingDatabase(app.db).then((ok) => {
      readyCache = { at: app.clock.now().getTime(), ok };
      readyInFlight = null;
      return ok;
    });
    return readyInFlight;
  };

  app.get(
    "/health/ready",
    {
      config: { auth: "public", rateLimit: rateLimitByIp({ max: 60, timeWindow: "1 minute" }) },
      schema: { response: { 200: healthResponseSchema, 503: healthResponseSchema } }
    },
    async (_request, reply) => {
      const dbOk = await readiness();
      return reply.code(dbOk ? 200 : 503).send({ ok: dbOk, service: SERVICE_NAME, db: dbOk });
    }
  );

  const apiModules = [
    authModule,
    invitesModule,
    profileModule,
    directoryModule,
    cuencadasModule,
    rsvpModule,
    mediaModule,
    familyModule,
    chatModule,
    announcementsModule,
    adminModule
  ];
  for (const apiModule of apiModules) {
    await app.register(apiModule, { prefix: "/api" });
  }
}
