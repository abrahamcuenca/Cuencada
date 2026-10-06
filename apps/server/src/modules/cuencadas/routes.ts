import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cuencadas } from "../../db/schema.js";
import { seededCuencada2026 } from "./data.js";

export async function registerCuencadaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/cuencadas", async () => ({ cuencadas: [seededCuencada2026] }));

  app.get("/cuencadas/:year", async (request, reply) => {
    const params = z.object({ year: z.coerce.number().int() }).parse(request.params);
    if (params.year === 2026) return reply.send({ cuencada: seededCuencada2026 });
    return reply.code(404).send({ error: "No encontramos esa Cuencada." });
  });

  app.post("/admin/cuencadas", async (request, reply) => {
    const admin = await app.auth.requireAdmin(request, reply);
    if (!admin) return;

    const body = z.object({
      year: z.number().int().min(1900).max(2200),
      title: z.string().min(1),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      city: z.string().min(1),
      state: z.string().min(1),
      description: z.string().min(1)
    }).parse(request.body);

    const [created] = await app.db.insert(cuencadas).values({
      ...body,
      slug: String(body.year),
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      isPublished: false
    }).returning();

    return reply.code(201).send({ cuencada: created });
  });

  app.patch("/admin/cuencadas/:id/publish", async (request, reply) => {
    const admin = await app.auth.requireAdmin(request, reply);
    if (!admin) return;
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await app.db.update(cuencadas).set({ isPublished: true }).where(eq(cuencadas.id, params.id));
    return reply.send({ ok: true });
  });
}
