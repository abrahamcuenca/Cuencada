import argon2 from "argon2";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashToken } from "../../auth.js";
import { users } from "../../db/schema.js";

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12)
});

const magicLinkBodySchema = z.object({
  email: z.string().email()
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", async (request, reply) => {
    const body = loginBodySchema.parse(request.body);
    const [user] = await app.db.select().from(users).where(eq(users.email, body.email.toLowerCase())).limit(1);

    if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, body.password))) {
      return reply.code(401).send({ error: "Correo o contraseña incorrectos." });
    }

    const currentUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role === "admin" ? "admin" : "member",
      mustChangePassword: user.mustChangePassword
    } as const;
    const accessToken = await app.auth.signAccessToken(currentUser);

    return reply.send({ user: currentUser, accessToken });
  });

  app.get("/me", async (request, reply) => {
    const user = await app.auth.requireUser(request, reply);
    if (!user) return;
    return reply.send({ user });
  });

  app.post("/auth/change-password", async (request, reply) => {
    const currentUser = await app.auth.requireUser(request, reply);
    if (!currentUser) return;

    const body = changePasswordBodySchema.parse(request.body);
    const [user] = await app.db.select().from(users).where(eq(users.id, currentUser.id)).limit(1);
    if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, body.currentPassword))) {
      return reply.code(401).send({ error: "La contraseña actual no es correcta." });
    }

    const passwordHash = await argon2.hash(body.newPassword);
    await app.db.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, currentUser.id));

    return reply.send({ ok: true });
  });

  app.post("/auth/magic-link/request", async (request, reply) => {
    magicLinkBodySchema.parse(request.body);
    // Email sending is intentionally deferred until the mail provider is wired.
    // Keep the response generic to avoid email enumeration.
    return reply.send({ ok: true, message: "Si el correo está registrado, enviaremos un enlace de acceso." });
  });

  app.post("/invites/accept", async (request, reply) => {
    const body = z.object({ token: z.string().min(32) }).parse(request.body);
    const tokenHash = hashToken(body.token);
    return reply.code(501).send({ error: "La aceptación de invitaciones se implementará en el siguiente corte.", tokenHashPreview: tokenHash.slice(0, 8) });
  });
}
