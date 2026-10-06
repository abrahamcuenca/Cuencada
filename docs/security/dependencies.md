# Dependency review

WP-2.3 · 2026-10-06 · lockfile at `main` @ `28c55aa`

## `pnpm audit`

| Scope | Result |
|---|---|
| `pnpm audit` (all workspaces, dev and prod) | **No known vulnerabilities found** |
| `pnpm audit --prod` | **No known vulnerabilities found** |

CI already runs the production audit (`mise run verify`, `ci.yml`). WP-0.8a's
overrides are still in place: the Vitest 4.1.11 bump, and esbuild `^0.25.12`
for drizzle-kit's `@esbuild-kit/core-utils`.

## Production licenses (`pnpm licenses list --prod`)

| License | Packages |
|---|---|
| MIT | 113 |
| Apache-2.0 | 29 |
| ISC | 9 |
| BSD-2-Clause | 5 |
| BSD-3-Clause | 3 |
| Unlicense | 2 |
| MIT-0, 0BSD | 1 each |
| **LGPL-3.0-or-later** | **1: `@img/sharp-libvips-linux-x64@1.3.4`** |

No GPL, AGPL, SSPL, MPL or EPL dependency ships to production.

The one weak-copyleft package is the **prebuilt libvips binary** that sharp
loads. It is used unmodified, dynamically linked, and server-side only: the
binary is never distributed to users. The LGPL therefore imposes no
obligation on the project. If the project ever ships a bundle that contains
the binary (for example a downloadable image), include the LGPL text and the
libvips source offer. This is recorded as accepted risk A8 in
[threat-model.md](threat-model.md).

## GitHub Actions pins (`.github/workflows/ci.yml`)

| Action | Pinned SHA | Tag | Latest release | Tag → SHA matches |
|---|---|---|---|---|
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1 | v7.0.1 | yes |
| `pnpm/action-setup` | `ea17c68df8912ef543352723c149a84f56e3d413` | v6.1.0 | v6.1.0 | yes |
| `actions/setup-node` | `820762786026740c76f36085b0efc47a31fe5020` | v7.0.0 | v7.0.0 | yes |

The checks were run with `gh api repos/<action>/releases/latest` and
`gh api repos/<action>/commits/<tag>`.

The workflow also has these settings:

- `permissions: contents: read`.
- `persist-credentials: false` on checkout.
- `pull_request` triggers only (no `pull_request_target`).
- No secrets.

**Low (WP-2.3 L4):** the CI Postgres service image `postgres:16-alpine` is
pinned by tag, not by digest. It only runs tests and holds no secrets. Pin
the digest if you want to be strict.

## Notable direct dependencies

These are the security-relevant direct dependencies (versions from the
lockfile):

- **Server:** `fastify` 5.12, `@fastify/helmet`, `@fastify/cors`,
  `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/websocket`, `jose` 6,
  `argon2` 0.44, `zod` 4.6, `drizzle-orm` 0.45, `postgres` 3.4,
  `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` 3.x, `sharp`
  0.35, `resend` 6.30.
- **Web:** React 19, Redux Toolkit / RTK Query, `vite-plugin-pwa` / Workbox.

All of them are actively maintained upstream projects. None is deprecated,
and `pnpm install` printed no deprecation warning for them.

`fastify-type-provider-zod@7` pulls in `@fastify/swagger` as a required peer.
It is unused at runtime and adds no route (the route inventory confirms there
is no `/documentation` route).

## Process

- `minimumReleaseAge: 10080` (7 days) in `pnpm-workspace.yaml` delays brand-new versions.
  This protects against typosquat and account-takeover releases.
- New dependencies require a rebase and `pnpm install`. Never hand-merge
  `pnpm-lock.yaml` (coordination README).
- Re-run this review before each deploy (`mise run verify`), and whenever a
  dependency that touches the DOM, CSS-in-JS or `eval` is added (see
  [csp.md](csp.md)).
