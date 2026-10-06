## WP
WP-<id> · Coordination file: `docs/coordination/WP-<id>.md` · [SEC]? yes/no

## Summary
<!-- What changed and why -->

## Checklist
- [ ] `mise run verify` passes locally (lint, typecheck, tests against podman Postgres, audit)
- [ ] Tests cover the happy path, invalid input (400), and unauthorized (401/403) for every new route
- [ ] Only touches files owned by this WP (see `docs/coordination/README.md`)
- [ ] JSDoc on exported functions and route handlers; no `any`, no `!`, no `console.log`

### UI (if applicable)
- [ ] Designed mobile-first (360–414px), `min-width` breakpoints only
- [ ] Screenshots attached at **375px** and **1280px**
- [ ] Touch targets ≥ 44px, inputs ≥ 16px font, no horizontal scroll at 320px
- [ ] Spanish copy; legacy production links unchanged

### Security (if applicable)
- [ ] Input validated at the boundary (zod); responses go through response schemas (no PII over-fetch)
- [ ] Authorization checked server-side (route `config.auth` + ownership/IDOR checks)
- [ ] Tokens hashed at rest; no secrets/PII in logs or URLs
- [ ] Sensitive mutations write an audit log entry

## Reviews
- [ ] Tech Lead approval
- [ ] Security Engineer approval ([SEC] only)
