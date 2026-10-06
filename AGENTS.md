# AGENTS.md

## Repo Shape

- This repo is being migrated from a static single-page site to a full-stack Acleron app.
- The new app lives in a pnpm/turbo monorepo: `apps/web` is the React/Vite frontend, `apps/server` is the Fastify API, and `packages/types` contains shared contracts.
- `index.html` is the legacy static page and `cuencada2026.html` is an older/simpler copy. Treat them as migration references, not active app entrypoints, unless the user asks.
- Existing static assets remain under root `images/` and `canciones/`; migrate needed assets into `apps/web/public/` before depending on them in the new build.

## Commands

- Install with `pnpm install`.
- Use `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` from the repo root.
- Use `pnpm --filter @cuencada/web dev` for the frontend and `pnpm --filter @cuencada/server dev` for the API.
- Use `mise run verify` before deploy work; it runs lint, typecheck, tests, and production audit.

## Acleron

- `infra/project.yml` targets `cuencada.com` on `server_1` with bundled deploy mode and backend port `3104`; verify the port with `mise run ports -- server_1` before deploying.
- Acleron deployment tasks are in `mise.toml`; mutating deploys still require explicit approval.
- Required vault refs include `vault_cuencada_database_url`, `vault_cuencada_jwt_secret`, `vault_cuencada_seed_admin_temp_password`, and Linode Object Storage `vault_cuencada_s3_*` values.
- Do not commit vault files, deploy keys, object storage credentials, or generated secrets.

## Privacy And Access

- `/cuencada/:year` is partially public; photos, RSVPs, attendee circles, chat, directory, and family tree require login.
- RSVP requires an account. Admins manually create past/future Cuencadas and historical attendance.
- Invite tokens, magic-link tokens, and refresh/session tokens must be stored hashed, not plaintext.
- Directory contact fields and family tree data are PII; default to member-only and honor profile visibility.

## Editing Notes

- Keep the site self-contained unless asked otherwise: HTML, CSS, and JavaScript currently live inline in `index.html`.
- Preserve Spanish copy and the mobile-first event-site style.
- Be careful with external links: OneDrive, WhatsApp, WeatherWidget, hotel links, and Google Maps are user-facing production links.
- `mensajes.txt` contains date-keyed messages in `YYYY-MM-DD|message` format; the message-loading script in `index.html` is currently commented out.
- The initial admin is `admin@cuencada.com`; the temporary password belongs in vault/env and must force password change on first login.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
