/**
 * MSW helpers for T1 tests, built from the WP-0.2 contract schemas so the
 * fake server rejects bodies the real one would reject and never answers
 * with a shape the real one could not send. Test-only: nothing in `src`
 * outside `*.test.tsx` imports this file.
 */
import {
  type ApiError,
  type AuthTokenResponse,
  authTokenResponseSchema,
  type CurrentUser,
  type ErrorCode,
  errorHttpStatus,
  type InviteInspectResponse,
  inviteInspectResponseSchema,
  type SessionListItem,
  sessionListItemSchema
} from "@cuencada/types";
import { HttpResponse, http, type HttpHandler } from "msw";
import { apiUrl, makeUser } from "../../../../test/auth";

/** Structural zod schema (the web package does not depend on zod directly). */
interface Parser<TData> {
  parse: (value: unknown) => TData;
  safeParse: (value: unknown) => { success: boolean };
}

/** What a contract route handler receives. */
export interface ContractRequest<TBody> {
  body: TBody;
  request: Request;
  params: Record<string, string | readonly string[] | undefined>;
}

/**
 * A handler for `method path` that validates the JSON body with the contract
 * input schema (400 `VALIDATION` when it fails) before calling `respond`.
 *
 * @param method - HTTP method.
 * @param path - API path, e.g. `/auth/login`.
 * @param inputSchema - Contract input schema, or `null` for routes without a body.
 * @param respond - Builds the response from the validated body.
 * @returns An MSW handler.
 */
export function contractRoute<TBody>(
  method: "post" | "delete" | "get",
  path: string,
  inputSchema: Parser<TBody> | null,
  respond: (request: ContractRequest<TBody>) => Response | Promise<Response>
): HttpHandler {
  return http[method](apiUrl(path), async ({ request, params }) => {
    let body: unknown;
    if (inputSchema !== null) {
      body = await request.json().catch(() => undefined);
      if (!inputSchema.safeParse(body).success) return apiError("VALIDATION", "Datos inválidos.");
      body = inputSchema.parse(body);
    }
    // Validated above (or `undefined` for body-less routes, where TBody is unused).
    return respond({ body: body as TBody, request, params });
  });
}

/**
 * @param code - Contract error code; the HTTP status comes from `errorHttpStatus`.
 * @param message - Spanish server message.
 * @returns A contract error response.
 */
export function apiError(code: ErrorCode, message = "Error de prueba."): Response {
  const body: ApiError = { error: { code, message } };
  return HttpResponse.json(body, { status: errorHttpStatus[code] });
}

/**
 * @param user - The logged-in user.
 * @param accessToken - Token value.
 * @param status - 200 (login) or 201 (invite accept).
 * @returns A schema-checked `AuthTokenResponse`.
 */
export function tokenResponse(user: CurrentUser = makeUser(), accessToken = "token-nuevo", status = 200): Response {
  const body: AuthTokenResponse = authTokenResponseSchema.parse({
    accessToken,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    user
  });
  return HttpResponse.json(body, { status });
}

/** @returns A 202 `OkResponse`. */
export function okAccepted(): Response {
  return HttpResponse.json({ ok: true }, { status: 202 });
}

/** @returns A 204 with no body. */
export function noContent(): Response {
  return new HttpResponse(null, { status: 204 });
}

/**
 * @param overrides - Fields to change.
 * @returns A schema-checked `InviteInspectResponse` for a member invite bound to `tia.lupe@example.com`.
 */
export function makeInvite(overrides: Partial<InviteInspectResponse> = {}): InviteInspectResponse {
  return inviteInspectResponseSchema.parse({
    emailMasked: "t***@e***.com",
    role: "member",
    expiresAt: "2026-10-20T18:00:00.000Z",
    invitedByName: "Jorge Ejemplo",
    suggestedDisplayName: "Lupe Ejemplo",
    ...overrides
  });
}

/**
 * @param overrides - Fields to change.
 * @returns A schema-checked `SessionListItem`.
 */
export function makeSession(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return sessionListItemSchema.parse({
    id: "0b9c6c1e-3f4a-4c2b-9d8e-7f6a5b4c3d2e",
    createdAt: "2026-10-01T15:00:00.000Z",
    lastUsedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    expiresAt: "2026-11-01T15:00:00.000Z",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ipAddress: "189.203.10.4",
    current: true,
    ...overrides
  });
}

/** A valid fragment token (32–256 base64url characters). */
export const FRAGMENT_TOKEN = "Zt7".repeat(12);
