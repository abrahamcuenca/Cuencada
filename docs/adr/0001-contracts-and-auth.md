# ADR 0001: Shared zod contracts, response schemas as PII guard, token transport, error envelope

- Status: accepted (WP-0.2)
- Date: 2026-10-06
- Deciders: Software Architect, reviewed by Tech Lead and Security

## Context

Phase 1 builds frontend and backend tracks in parallel. They need one contract they cannot drift from. The server also handles PII (directory contacts, family tree, RSVPs) and single-use tokens (invites, magic links, password reset, email verification). In the scaffold these were handled ad hoc: inline zod in routes, `{ error: "string" }` bodies, and a stub that leaked a token-hash prefix.

## Decisions

### 1. zod 4 schemas live in `packages/types`

- `packages/types/src/<module>.ts` holds, for each module:
  - zod **input** schemas (`xxxSchema`, with input types `z.infer<typeof xxxSchema>`)
  - JSDoc'd **response interfaces** with a matching zod schema checked by `satisfies z.ZodType<Interface>`
  - unions as an `as const` object plus `z.enum(obj)`, never a TS `enum`
- The package is ESM. Source imports use `.js` suffixes and the package compiles with `NodeNext`, so the server (NodeNext) and Vite (bundler) both consume `dist/`. zod is a runtime dependency (`^4`, same major as the server).
- The web uses the same input schemas for forms, so client and server validation cannot drift.
- Defensive limits are mandatory. Every string has a `max`. Text is trimmed, and emails are trimmed and lowercased *before* validation (`emailSchema`). Admin-entered links must be `https:`, which blocks `javascript:` and `data:`. Uploads use an allowlist of MIME types and per-kind size limits.
- PATCH inputs are built from field maps **without defaults** and then `.partial()`, so a partial update never resets omitted fields to their defaults.
- `src/index.ts` re-exports every module and is **frozen** after this WP. Phase-1 tracks edit only their own module file.

### 2. Response schemas are the PII guard

- Every route declares a response schema through `fastify-type-provider-zod`. zod objects strip unknown keys, so a column that is accidentally selected (for example `passwordHash`, `showPhone`, or a hidden phone) is never serialized.
- `DirectoryEntry` contact fields (`email`, `phone`, `city`) use `exactOptional()`. They are **absent** when hidden, not `null`, so a member can't learn that a field exists but is hidden. The service layer still has to omit them based on the visibility flags. The schema is defense in depth, not the only check.
- Response datetimes are ISO strings with an offset. The server converts `Date` values before replying, and serialization fails closed (500) on a mismatch.

### 3. Tokens travel in the body (and the URL fragment), never in the path or query

- Emails link to `https://cuencada.com/<page>#token=<opaque>`. The SPA reads the fragment and POSTs `{ token }` to `/api/invites/inspect`, `/api/invites/accept`, `/api/auth/magic-link/consume`, `/api/auth/password-reset/confirm`, or `/api/auth/email/verify`.
- Fragments are never sent to the server or in `Referer`, so tokens stay out of access logs and proxies. Email link scanners don't consume them, because a GET does nothing.
- The refresh token exists only in the `__Secure-cuencada_rt` cookie (HttpOnly, Secure, SameSite=Strict, Path=/api/auth). It is never in a JSON body. Refresh and logout also require the `X-Cuencada-CSRF` header and an exact `Origin` match. The access token is returned in the body and kept only in memory.
- **The one exception** is the WebSocket ticket. Browsers cannot set headers on a WS upgrade, so the 30-second, single-use ticket from `POST /api/chat/ticket` goes in `?ticket=`. The server must redact `ticket` from request logs, burn the ticket on first use, and check `Origin` on upgrade.
- Request-for-token endpoints (magic link, password reset) always answer 202 `{ ok: true }`, so they reveal nothing about which accounts exist.

### 4. Error envelope and codes

- Every non-2xx response is `ApiError`: `{ error: { code, message, details? } }`.
  - `code` comes from the `ErrorCode` as-const object, with its HTTP status fixed in `errorHttpStatus`.
  - `message` is Spanish, produced server-side, and safe to show to the user.
  - `details` lists `{ path, message }` for validation failures.
- The web branches on `code` only. Notable codes:
  - `TOKEN_EXPIRED` (401): the client refreshes and retries.
  - `UNAUTHENTICATED` (401): the client logs out.
  - `PASSWORD_CHANGE_REQUIRED` (403): the client routes to `/cambiar-contrasena`.
  - `REFRESH_RACE` (409): the client waits for the tab holding the `navigator.locks` lock.
  - `INVALID_CREDENTIALS`, `INVITE_INVALID` and `TOKEN_INVALID` are deliberately generic.
- Messages never contain stack traces, SQL, token material or other users' data. The server should call `z.config(z.locales.es())` for default messages. The contracts set explicit Spanish messages where the wording matters.

## Consequences

- Adding a field to a response means changing the interface **and** its schema. `satisfies` makes the compiler enforce this in one direction: a schema can't omit a field the interface requires.
- Phase-1 tracks can add schemas to their own module file, but must not rename anything exported here without going through the orchestrator.
- Web code must build the `packages/types` `dist/` before Vite dev (`turbo` already does this for `build` and `typecheck`).
