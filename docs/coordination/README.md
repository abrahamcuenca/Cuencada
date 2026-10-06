# Coordination board

Source of truth for multi-agent work. The full plan lives in [`../plan.md`](../plan.md).

## Workflow
1. The orchestrator dispatches a WP to an implementer agent on branch `wp/<id>-<slug>` (git worktree).
2. The implementer creates `docs/coordination/WP-<id>.md` from the template below and keeps it current.
3. The PR must pass `mise run verify` + CI. UI PRs attach screenshots at **375px and 1280px**.
4. The Tech Lead reviews every PR. The Security Engineer also reviews PRs tagged **[SEC]**.
5. A WP is **final** only once the required approvals are on the PR. The repo owner merges.
6. Cross-track questions go through the orchestrator, and every answer is recorded in the WP file.

## Ownership rules
- `apps/server/src/db/schema/**` and `apps/server/drizzle/**`: only WP-0.3 and WP-2.1.
- `app.ts`, `config.ts`, `router.tsx`, `store.ts`, `baseApi.ts`, and the `packages/types` barrel: Phase 0 only.
- Phase 1 tracks touch only `modules/<m>/**`, `features/<m>/**`, and `packages/types/src/<m>.ts`.
- New dependencies: rebase, then `pnpm install`. Never hand-merge `pnpm-lock.yaml`.

## Status

PRs #1–#29 are merged. Deferred and cross-track items live in [`backlog.md`](backlog.md).

| WP | Title | Owner | Reviewers | Branch | PR | Status |
|---|---|---|---|---|---|---|
| 0.0 | Baseline + repo hygiene | Tech Lead | — | main | — | done |
| 0.1 | Test infra (podman PG, Vitest, CI) | Backend | TL | wp/0.1-test-infra | #1 | merged |
| 0.2 | Contracts in packages/types [SEC] | Architect | TL, Sec | wp/0.2-contracts | #2 | merged |
| 0.3 | Schema split + migration 0001 + seed | Backend (data) | Architect, TL | wp/0.3-schema | #4 | merged |
| 0.4 | Server platform [SEC] | Backend | TL, Sec | wp/0.4-server-platform | #8 | merged |
| 0.5 | packages/emails | Frontend + UI/UX | TL | wp/0.5-emails | #5 | merged |
| 0.5.1 | Email hardening | Frontend | TL | wp/0.5.1-email-hardening | #7 | merged |
| 0.6 | Web foundation [SEC] | Frontend | TL, Sec | wp/0.6-web-foundation | #6 | merged |
| 0.7 | Mobile-first design system | UI/UX | TL | wp/0.7-design-system | #3 | merged |
| T1-FE | Auth screens [SEC] | Frontend | TL, Sec | wp/t1-fe-auth | #10 | merged |
| T1-BE | Auth, sessions & invites [SEC] | Backend | TL, Sec | wp/t1-be-auth | #14 | merged |
| T2-FE | Home, `/cuencada/:year`, admin content | Frontend | TL | wp/t2-fe-cuencadas | #11 | merged |
| T2-BE | Cuencadas content API (+ follow-up #21) | Backend | TL | wp/t2-be-cuencadas | #12, #21 | merged |
| T3-FE | RSVP card, attendees, admin attendance | Frontend | TL | wp/t3-fe-rsvp | #23 | merged |
| T3-BE | RSVP & attendance API (+ unlisted #19) [SEC] | Backend | TL, Sec | wp/t3-be-rsvp | #15, #19 | merged |
| T4-FE | Gallery, uploader, moderation [SEC] | Frontend | TL, Sec | wp/t4-fe-gallery | #9 | merged |
| T4-BE | Media pipeline [SEC] | Backend | TL, Sec | wp/t4-be-media | #13 | merged |
| T5-FE | Profile & directory [SEC] | Frontend | TL, Sec | wp/t5-fe-profile | #22 | merged |
| T5-BE | Profile, avatar & directory [SEC] | Backend | TL, Sec | wp/t5-be-profile | #20 | merged |
| T6-FE | Family tree + people editor [SEC] | Frontend | TL, Sec | wp/t6-fe-family | #18 | merged |
| T6-BE | Family tree API [SEC] | Backend | TL, Sec | wp/t6-be-family | #16 | merged |
| T7-BE | Real-time chat API [SEC] | Backend | TL, Sec | wp/t7-be-chat | #25 | merged |
| T7-FE | Real-time chat UI [SEC] | Frontend | TL, Sec | wp/t7-fe-chat | #28 | merged |
| T8-FE | Admin console [SEC] | Frontend | TL, Sec | wp/t8-fe-admin | #26 | merged |
| T8-BE | Admin console API (+ alerts #27) [SEC] | Backend | TL, Sec | wp/t8-be-admin | #24, #27 | merged |
| 2.1 | Migration 0002 | Backend (data) | Architect, TL | wp/2.1-migration-0002 | #17 | merged |
| 0.8a | Platform & repo hygiene [SEC] | Senior SWE | TL, Sec | wp/0.8a-platform-hygiene | | in progress |
| 0.8b | Backend module follow-ups | Backend | TL, Sec | — | | in progress |
| 0.8c | Web feature follow-ups | Frontend | TL | — | | in progress |
| T9 | PWA (generateSW, public-only API cache, logout purge) | Frontend | TL, Sec | wp/t9-pwa | #29 | merged |
| 2.4–2.5 | Cutover (see backlog checklist) | Tech Lead | Sec | — | | todo |

## WP file template

```md
# WP-<id> <title>
Owner: <role> · Reviewers: <roles> · Branch: wp/<id>-<slug> · PR: #
## Scope
## Interfaces consumed / exposed
## Decisions
## Open questions (→ orchestrator)
## Review log
```
