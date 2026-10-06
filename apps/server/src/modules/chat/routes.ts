import type { FastifyInstance } from "fastify";

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get("/chat/global/messages", async (request, reply) => {
    const user = await app.auth.requireUser(request, reply);
    if (!user) return;
    return reply.send({ messages: [] });
  });
}
