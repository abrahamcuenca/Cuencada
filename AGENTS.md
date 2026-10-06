# AGENTS.md

## Repo Shape

- This repo is being migrated from a static single-page site to a full-stack Acleron app.
- The new app lives in a pnpm/turbo monorepo: `apps/web` is the React/Vite frontend, `apps/server` is the Fastify API, and `packages/types` contains shared contracts.
- `index.html` is the legacy static page and `cuencada2026.html` is an older/simpler copy. Treat them as migration references, not active app entrypoints, unless the user asks.
- Existing static assets remain under root `images/` and `canciones/`; migrate needed assets into `apps/web/public/` before depending on them in the new build.

## Commands

- Install with `pnpm install`.
- Use `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` from the repo root.
- `pnpm test` needs the test Postgres: run `scripts/test-db.sh up` first. Never run `scripts/test-db.sh down` while other agents may share the container.
- Use `pnpm --filter @cuencada/web dev` for the frontend and `pnpm --filter @cuencada/server dev` for the API.
- Use `mise run verify` before deploy work; it runs lint, typecheck, tests, and production audit.
- Never use `drizzle-kit push`; apply schema only via migrations (`db:migrate`). `drizzle.config.ts` refuses `push`/`drop` unless `ALLOW_DRIZZLE_PUSH=1` and the database is on loopback. There is no `db:push` script; do not add one.

## Acleron

- `infra/project.yml` targets `cuencada.com` on `server_1` with bundled deploy mode and backend port `3104`; verify the port with `mise run ports -- server_1` before deploying.
- Acleron deployment tasks are in `mise.toml`; mutating deploys still require explicit approval.
- Required vault refs include `vault_cuencada_database_url`, `vault_cuencada_jwt_secret`, `vault_cuencada_resend_api_key`, and Linode Object Storage `vault_cuencada_s3_*` values. `vault_cuencada_seed_admin_temp_password` is operator-only: it is passed to the one-off prod seed by hand, never to the running API (WP-0.4).
- Do not commit vault files, deploy keys, object storage credentials, or generated secrets.

## Privacy And Access

- `/cuencada/:year` is partially public; photos, RSVPs, attendee circles, chat, directory, and family tree require login.
- RSVP requires an account. Admins manually create past/future Cuencadas and historical attendance.
- Invite tokens, magic-link tokens, and refresh/session tokens must be stored hashed, not plaintext.
- Directory contact fields and family tree data are PII; default to member-only and honor profile visibility.
- This repository is public. Fixtures, seeds, docs, wireframes, style guides and screenshots use fictional people only (e.g. "Ana Morales Vega", branch "Rama Norte", phones `+52 555 0…`, `@example.com` emails). Never use real family names or real family photos: real photos are members-only (private gallery). The only exception is the legacy root site (`index.html`, `cuencada2026.html`, root `images/`), pending retirement at cutover.
- Never interpolate PII (emails, names, phones, tokens) into `Error` messages or log lines; errors get logged. Keep identifiers in structured fields that the logger redacts.

## Agent Workflow

- Run git with explicit paths (`git add <files>`, never `git add -A` or `git add .`). Never use bare `git stash`/`git stash pop`; the stash is shared between worktrees.
- Agents share one scratchpad: prefix every temp file with the WP id (e.g. `w08a-commit-msg.txt`).
- Before merging a PR, merge the latest `main` into the branch and run the full suite (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`).
- Deferred and cross-track work (including the CSP/nginx cutover checklist) lives in `docs/coordination/backlog.md`; add items there instead of leaving TODOs in code.

## Editing Notes

- Legacy page only: the root `index.html` keeps its HTML, CSS, and JavaScript inline and self-contained. The new app lives in `apps/web` (React/Vite) and `apps/server`.
- Preserve Spanish copy and the mobile-first event-site style.
- Be careful with external links: OneDrive, WhatsApp, WeatherWidget, hotel links, and Google Maps are user-facing production links.
- `mensajes.txt` contains date-keyed messages in `YYYY-MM-DD|message` format. The seed (`apps/server/src/seed.ts`) imports them as daily messages; the loader in the legacy `index.html` is commented out.
- The initial admin is `admin@cuencada.com`; the temporary password belongs in vault/env and must force password change on first login.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
