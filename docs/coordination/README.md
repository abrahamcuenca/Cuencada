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

| WP | Title | Owner | Reviewers | Branch | PR | Status |
|---|---|---|---|---|---|---|
| 0.0 | Baseline + repo hygiene | Tech Lead | — | main | — | in progress |
| 0.1 | Test infra (podman PG, Vitest, CI) | Backend | TL | wp/0.1-test-infra | | todo |
| 0.2 | Contracts in packages/types | Architect | TL, Sec | wp/0.2-contracts | | todo |
| 0.3 | Schema split + migration 0001 + seed | Backend (data) | Architect, TL | wp/0.3-schema | | todo |
| 0.4 | Server platform | Backend | TL, Sec | wp/0.4-server-platform | | todo |
| 0.5 | packages/emails | Frontend + UI/UX | TL | wp/0.5-emails | | todo |
| 0.6 | Web foundation | Frontend | TL, Sec | wp/0.6-web-foundation | | todo |
| 0.7 | Mobile-first design system | UI/UX | TL | wp/0.7-design-system | | todo |

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
