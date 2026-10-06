import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { AppConfig } from "./config.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
  mustChangePassword: boolean;
}

export interface AuthContext {
  signAccessToken(user: AuthenticatedUser): Promise<string>;
  verifyRequest(request: FastifyRequest): Promise<AuthenticatedUser | null>;
  requireUser(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null>;
  requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null>;
}

export function createAuthContext(config: AppConfig): AuthContext {
  const secret = new TextEncoder().encode(config.JWT_SECRET);

  async function signAccessToken(user: AuthenticatedUser): Promise<string> {
    return new SignJWT({
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      mustChangePassword: user.mustChangePassword
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(secret);
  }

  async function verifyRequest(request: FastifyRequest): Promise<AuthenticatedUser | null> {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;

    try {
      const { payload } = await jwtVerify(header.slice("Bearer ".length), secret);
      if (!payload.sub || typeof payload.email !== "string" || typeof payload.displayName !== "string") return null;
      if (payload.role !== "admin" && payload.role !== "member") return null;

      return {
        id: payload.sub,
        email: payload.email,
        displayName: payload.displayName,
        role: payload.role,
        mustChangePassword: payload.mustChangePassword === true
      };
    } catch {
      return null;
    }
  }

  async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null> {
    const user = await verifyRequest(request);
    if (!user) {
      await reply.code(401).send({ error: "No has iniciado sesión." });
      return null;
    }
    return user;
  }

  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null> {
    const user = await requireUser(request, reply);
    if (!user) return null;
    if (user.role !== "admin") {
      await reply.code(403).send({ error: "No tienes permiso para ver esta sección." });
      return null;
    }
    return user;
  }

  return { signAccessToken, verifyRequest, requireUser, requireAdmin };
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
