/**
 * Cuencadas module (T2 owns this folder).
 *
 * The scaffold routes are kept working on the new platform. The public reads
 * still serve `data.ts` (non-uuid ids), so they deliberately have no response
 * schema; T2 replaces them with DB-backed reads and full contracts.
 */
import { AuditAction, idParamSchema, yearParamSchema } from "@cuencada/types";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { cuencadas } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { seededCuencada2026 } from "./data.js";

const legacyCreateCuencadaSchema = z.object({
  year: z.number().int().min(1900).max(2200),
  title: z.string().trim().min(1).max(200),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(5000)
});

/** Cuencada routes under `/api`. */
const cuencadasModule: FastifyPluginAsyncZod = async (app) => {
  app.get("/cuencadas", { config: { auth: "public" } }, async () => ({ cuencadas: [seededCuencada2026] }));

  app.get(
    "/cuencadas/:year",
    { config: { auth: "public" }, schema: { params: yearParamSchema } },
    async (request) => {
      if (request.params.year === seededCuencada2026.year) return { cuencada: seededCuencada2026 };
      throw new AppError("NOT_FOUND", "No encontramos esa Cuencada.");
    }
  );

  app.post(
    "/admin/cuencadas",
    { config: { auth: "admin" }, schema: { body: legacyCreateCuencadaSchema } },
    async (request, reply) => {
      const admin = authUser(request);
      const body = request.body;
      const created = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(cuencadas)
          .values({
            ...body,
            slug: String(body.year),
            startsAt: new Date(body.startsAt),
            endsAt: new Date(body.endsAt),
            isPublished: false
          })
          .returning();
        if (row === undefined) throw new Error("create cuencada: insert returned no row");
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.CuencadaCreated,
          entityType: "cuencada",
          entityId: row.id,
          metadata: { year: row.year },
          ip: request.ip
        });
        return row;
      });
      return reply.code(201).send({ cuencada: created });
    }
  );

  // Retired by the contract (publish via PATCH /admin/cuencadas/:id); T2 removes it.
  app.patch(
    "/admin/cuencadas/:id/publish",
    { config: { auth: "admin" }, schema: { params: idParamSchema } },
    async (request) => {
      const admin = authUser(request);
      await app.db.transaction(async (tx) => {
        const updated = await tx
          .update(cuencadas)
          .set({ isPublished: true })
          .where(eq(cuencadas.id, request.params.id))
          .returning({ id: cuencadas.id });
        if (updated.length === 0) throw new AppError("NOT_FOUND", "No encontramos esa Cuencada.");
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.CuencadaPublished,
          entityType: "cuencada",
          entityId: request.params.id,
          ip: request.ip
        });
      });
      return { ok: true };
    }
  );
};

export default cuencadasModule;
