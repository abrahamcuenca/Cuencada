import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { createAuthContext, type AuthContext } from "./auth.js";
import type { AppConfig } from "./config.js";
import { createDatabase, type Database } from "./db/client.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerChatRoutes } from "./modules/chat/routes.js";
import { registerCuencadaRoutes } from "./modules/cuencadas/routes.js";
import { registerGalleryRoutes } from "./modules/gallery/routes.js";

declare module "fastify" {
  interface FastifyInstance {
    auth: AuthContext;
    config: AppConfig;
    db: Database;
  }
}

export async function buildApp(config: AppConfig) {
  const app = Fastify({ logger: config.NODE_ENV !== "test" });
  app.decorate("config", config);
  app.decorate("db", createDatabase(config));
  app.decorate("auth", createAuthContext(config));

  await app.register(helmet);
  await app.register(cors, { origin: config.CORS_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  app.get("/health", async () => ({ ok: true, service: "cuencada-api" }));

  await app.register(registerAuthRoutes, { prefix: "/api" });
  await app.register(registerCuencadaRoutes, { prefix: "/api" });
  await app.register(registerGalleryRoutes, { prefix: "/api" });
  await app.register(registerChatRoutes, { prefix: "/api" });

  return app;
}
