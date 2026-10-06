# Content Security Policy

WP-2.3 · Security Engineer · 2026-10-06

There are two policies:

1. **API responses** (`/api/**`, `/health*`): sent by helmet from
   [`apps/server/src/plugins/security.ts`](../../apps/server/src/plugins/security.ts),
   asserted on live responses by
   [`headers.test.ts`](../../apps/server/src/__tests__/security/headers.test.ts).
   JSON bodies don't execute, so this policy is defence in depth.
2. **SPA HTML and static files** (`index.html`, `/assets/**`, `sw.js`,
   `workbox-*.js`, `sw-purge.js`, the manifest and icons). nginx serves these
   files, not Fastify, so **WP-2.4 must send the policy below from nginx.**
   This is the policy that protects users.

## SPA policy for nginx (WP-2.4)

Production values: the bucket is `<bucket>` in region `us-southeast-1`, so its
origin is `https://<bucket>.us-southeast-1.linodeobjects.com`. If
`S3_PUBLIC_BASE_URL` is set, add its origin next to the bucket host in
`img-src`, `media-src` and `connect-src`.

```nginx
# server { … } for cuencada.com. Repeat every add_header inside any location
# that has its own add_header, because nginx drops the inherited ones.
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://<bucket>.us-southeast-1.linodeobjects.com; media-src 'self' blob: https://<bucket>.us-southeast-1.linodeobjects.com; connect-src 'self' wss://cuencada.com https://<bucket>.us-southeast-1.linodeobjects.com; font-src 'self'; frame-src https://weatherwidget.io; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; upgrade-insecure-requests" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
```

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'self'` | Deny by default. |
| `script-src` | `'self'` | Vite emits one external module entry and lazy chunks. There's no inline script (`injectRegister: null`, no modulepreload polyfill inline), no `eval`, and no third-party script. The weather widget is an iframe, not a script (WP-0.4). |
| `style-src` | `'self'` | **No `'unsafe-inline'` needed.** The built `index.html` has no `<style>` and no `style=""`. CSS Modules are extracted to `/assets/*.css`. React `style={…}` props (WeatherWidget height, Skeleton, TreeParts, AvatarEditor) are applied through the CSSOM (`element.style.x = …`), which CSP doesn't restrict. The Chromium run below confirms it. |
| `img-src` | `'self' data: blob: <bucket>` | `blob:` covers the avatar/upload previews (`URL.createObjectURL`). `data:` is for tiny inline icons. Presigned GET URLs point only at the bucket's own host. **The shared regional endpoint `https://us-southeast-1.linodeobjects.com` is never allowed**, because path-style URLs would reach any customer's bucket. |
| `media-src` | `'self' blob: <bucket>` | Videos and song. `data:` isn't needed. |
| `connect-src` | `'self' wss://cuencada.com <bucket>` | API (`'self'`), chat socket, and direct presigned PUT uploads to the bucket. |
| `font-src` | `'self'` | System fonts only. |
| `frame-src` | `https://weatherwidget.io` | Only the weather iframe (`https://weatherwidget.io/w/`, sandboxed, see WP-0.4's embed contract). The SPA frames nothing of its own, so `'self'` isn't needed. |
| `frame-ancestors` | `'none'` | No one may frame the app (clickjacking). `X-Frame-Options: DENY` covers old browsers. |
| `base-uri` | `'none'` | The SPA has no `<base>`. |
| `form-action` | `'self'` | Forms are handled in JS. This blocks injected forms that would post off-site. |
| `manifest-src` / `worker-src` | `'self'` | PWA manifest and `sw.js` (`importScripts("/sw-purge.js")` is same-origin). |
| `object-src` | `'none'` | No plugins. |
| `upgrade-insecure-requests` | | Defence in depth behind HSTS. |

`Referrer-Policy` on HTML is `strict-origin-when-cross-origin`, matching the
`<meta name="referrer">` in `apps/web/index.html`. Outbound links (WhatsApp,
Maps, hotels) get the origin only, never a path or a `#t=` fragment. The API
keeps `no-referrer`.

### Differences from `contentSecurityPolicy(config)`

WP-0.4 suggested rendering the nginx header with `contentSecurityPolicy(config)`
from `security.ts`. That function produces the API policy, which is slightly
looser than the policy above: it has `base-uri 'self'` and
`frame-src 'self' https://weatherwidget.io`. Either paste the string above, or
first align the function with it. The second option is tracked as a Low in
[`backlog.md`](../coordination/backlog.md) under "WP-2.3 findings".

## Verification (headless Chromium)

[`csp-check.mjs`](csp-check.mjs) does the following:

- Serves `apps/web/dist` with exactly this policy, with `ws://` standing in
  for `wss://cuencada.com` on the local origin.
- Proxies `/api` and the chat WebSocket to the **real built API**, running on a
  scratch database (migrated and seeded with fictional fixtures).
- Drives headless Chromium through the main routes.
- Collects every `securitypolicyviolation` event and every CSP console error.

```sh
pnpm build && scripts/test-db.sh up
node docs/security/csp-check.mjs
```

The real API stands in for a stubbed one. It returns real response shapes, so
every page renders its normal states, including the weather iframe and the chat
socket.

Result on `main` @ `28c55aa` + WP-2.3, 2026-10-06:

| Scope | Result |
|---|---|
| Public: `/`, `/cuencada/2026`, `/entrar`, `/recuperar`, `/invitacion`, 404 | 0 unexpected violations |
| Logged in (admin, verified): `/`, `/cuencada/2026`, `/perfil`, `/perfil/sesiones`, `/directorio`, `/arbol`, `/galeria/2026`, `/chat`, `/mas`, `/admin`, `/admin/usuarios`, `/admin/invitaciones`, `/admin/bitacora`, `/admin/media`, `/admin/cuencadas`, `/admin/familia` | 0 unexpected violations |
| Weather iframe rendered under `frame-src https://weatherwidget.io` | 2 frames, no violation |
| Service worker (`worker-src 'self'`, `importScripts`) | activated, no violation |
| Control: injected inline script, `style=""` attribute, off-bucket image, foreign iframe | all four blocked and reported (`script-src-elem`, `style-src-attr`, `img-src`, `frame-src`), which proves the instrumentation works |
| Known and accepted | 1 blocked `eval` per page load: zod 4's capability probe `new Function("")` inside a `try/catch` (`allowsEval`). CSP blocks it and zod falls back to its non-JIT parser, so nothing breaks. It does emit a violation report on every load. **Fix (Low, web):** call `z.config({ jitless: true })` in `apps/web/src/main.tsx` before any schema runs. See the backlog. |

Re-run the harness in WP-2.4 against the final nginx config. Also recheck it
whenever a dependency that might inject `<style>` (CSS-in-JS) or use `eval` is
added.

## Future hardening (optional)

- `require-trusted-types-for 'script'`: React 19 DOM writes are compatible,
  but the zod probe and any future library would need a default policy. Try
  it in `Content-Security-Policy-Report-Only` first.
- A `report-to` endpoint, once the zod probe is silenced.
