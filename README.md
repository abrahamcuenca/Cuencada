# Cuencada

The private portal of the Familia Cuenca's reunion, the Cuencada: the public program of each edition, plus, for logged-in relatives, RSVPs, the photo album, the family directory, the family tree and a chat. The UI is in Spanish and mobile-first. It is deployed to `cuencada.com` with Acleron.

This repository is public: fixtures, seeds and screenshots use fictional people only.

## Layout

pnpm + Turborepo monorepo:

| Path | What |
|---|---|
| `apps/web` | React + Vite SPA (Redux Toolkit / RTK Query, PWA) |
| `apps/server` | Fastify API, PostgreSQL via Drizzle (migrations in `apps/server/drizzle`) |
| `packages/types` | Shared contracts (zod schemas + types) |
| `packages/emails` | Transactional email templates |
| `tests/e2e` | Playwright journeys and mobile quality gates |
| `infra/`, `docs/deploy/` | Acleron deploy config, nginx and the runbook |
| `index.html`, `cuencada2026.html` | The legacy static site (reference only, retired at cutover) |

## Run locally

Prerequisites:

- Node 24 and pnpm 11 (`mise install` picks both up from `mise.toml`; `packageManager` is `pnpm@11.0.0`)
- podman (for the local Postgres)

```sh
pnpm install
pnpm build                                     # once: builds packages/types and packages/emails (the seed imports them)
cp .env.example .env                           # dev defaults: DB on 127.0.0.1:55433, mail printed to the terminal
scripts/dev-db.sh up                           # Postgres 16 in podman, port 55433, data kept in a named volume
pnpm --filter @cuencada/server db:migrate:dev
pnpm --filter @cuencada/server db:seed:dev     # admin, the 2026 edition, daily messages, chat rooms
pnpm dev                                       # API on 127.0.0.1:3006, web on http://localhost:5173
```

`pnpm dev` (`turbo dev`) builds `packages/types` and `packages/emails` first, then runs them in `tsc --watch` next to the API (`tsx watch`) and Vite, so edits to a shared package rebuild it and restart the API. A fresh clone works without the `pnpm build` step for `pnpm dev` itself; the step above is for the seed, which runs before it.

Open <http://localhost:5173> and log in as `admin@cuencada.com` / `Password123!` (the development fallback, used when `SEED_ADMIN_TEMP_PASSWORD` is empty). You must choose a new password first (at least 12 characters; the breached-password check is on, so pick a fresh passphrase).

The seeded admin's email starts unverified, so member pages show "Verifica tu correo". Either:

- tap "Reenviar enlace" in the banner: the dev mailer does not send anything; it prints every email (recipient, subject and the plain text, with the verify, magic-link, invite and reset links) in the `pnpm dev` terminal. Open the link from there; or
- set `SEED_DEV_VERIFY_ADMIN=1` in `.env` and run `db:seed:dev` again. It marks the admin verified. The seed refuses it unless `NODE_ENV=development`.

Notes:

- The `.env not found` notices from `db:*:dev` refer to the optional `apps/server/.env`; the root `.env` is read.
- Ports 3006 or 5173 taken (another checkout running)? Move both, keeping the API's allowed origin in step:
  `PORT=3016 APP_BASE_URL=http://localhost:5183 CORS_ORIGIN=http://localhost:5183 CUENCADA_DEV_PORT=5183 CUENCADA_DEV_API_ORIGIN=http://127.0.0.1:3016 pnpm dev`
  (the same keys can go in `.env`, except the two `CUENCADA_DEV_*`, which Vite reads from the shell or `apps/web/.env`).
- Gallery uploads need an S3-compatible bucket (`S3_*`, `VITE_MEDIA_UPLOAD_ORIGIN`); everything else works without one.
- `scripts/dev-db.sh status` and `scripts/dev-db.sh psql` inspect the database. `stop` and `down` keep your data; only `down --delete-data` deletes the volume.

## Tests

```sh
scripts/test-db.sh up      # disposable Postgres for Vitest (port 55432, tmpfs)
pnpm lint
pnpm typecheck
pnpm test                  # Vitest: server (real Postgres), web, packages
pnpm e2e                   # builds, then Playwright journeys (two phones + desktop), mobile gates and Lighthouse
```

`pnpm e2e` needs Playwright's Chromium once (`pnpm exec playwright install chromium`). It uses its own `*_e2e` database on the test cluster and never sends real email. `mise run verify` runs lint, typecheck, tests and the production dependency audit.

## Deploy and security

- Deploy and cutover: [`docs/deploy/runbook.md`](docs/deploy/runbook.md) (nginx: [`docs/deploy/nginx.md`](docs/deploy/nginx.md))
- Security: [`docs/security/`](docs/security/) (threat model, route access, CSP, OWASP checklist)
- Plan and work packages: [`docs/plan.md`](docs/plan.md), [`docs/coordination/`](docs/coordination/)
