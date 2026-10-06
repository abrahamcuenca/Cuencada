# nginx for cuencada.com

WP-2.4 · Tech Lead · 2026-10-06

The site lives in [`infra/nginx/cuencada.conf`](../../infra/nginx/cuencada.conf).
It is a complete nginx site file. It has no template markers, so it is valid as a
plain file and as a Jinja template.

## Why not Acleron's stock template

Acleron renders `/etc/nginx/sites-available/<id>` from its own
`templates/nginx-https-site.conf.j2` on every deploy. It has no hook for extra
directives. Rendered for Cuencada, that template would:

| Need | Stock template | Effect on Cuencada |
|---|---|---|
| Chat WebSocket at `/api/chat/ws` | Upgrade headers only on `location /ws`. `/api/` has none, and a 30 s read timeout | **Chat never connects** |
| SPA CSP from `docs/security/csp.md` | No CSP | The SPA ships without its main XSS defence |
| `X-Forwarded-For $remote_addr` (overwrite) | `$proxy_add_x_forwarded_for` (append) | With `trustProxy=loopback` the app still takes the right-most hop, so this is safe today. It breaks the owner's "overwrite, never append" rule, though, and the client's own header reaches the app. |
| No query strings in access logs | Default `combined` format, which logs `$request` | `?ticket=`, `?q=`, `?search=` and `?city=` land in `/var/log/nginx` |
| `no-cache` on `index.html`, `sw.js`, `sw-purge.js` and the manifest | `expires 1h` on `/` | PWA updates and security fixes reach clients up to an hour late |
| `X-Frame-Options DENY`, `Permissions-Policy`, HSTS as documented | `SAMEORIGIN`, no `Permissions-Policy`, HSTS 2 y + `preload` | Doesn't match csp.md |
| Missing hashed chunk answers 404 | SPA fallback answers 200 with HTML | A stale client gets HTML as JS |

The stock template has `canonical_redirect`, `health_path`, `immutable_dir` and
`rate_limits`. `infra/project.yml` sets those keys too, so a stock render is as
close as the stock template can get. It still breaks chat.

## Platform change (owner-approved, delivered)

The owner approved patching Acleron. The change sits on branch
**`cuencada-nginx-credentials`** of the local `acleron-platform` checkout,
commit `03f8049`. It is not pushed: the owner reviews it, merges it and pushes
it. The same commit also carries `server.credentials`, the Security M1 fix,
for secrets (see the runbook § 4).

- **`nginx.site_template`** is opt-in:
  - The new `ansible/roles/nginx/tasks/site_source.yml` resolves the path
    against the project root (`project_config | dirname | dirname`).
  - It rejects absolute paths and `..`.
  - The role renders that file instead of `templates/nginx-https-site.conf.j2`,
    through the same `nginx -t` gate.
  - Certbot's first-run HTTP bootstrap is unchanged.
  - Projects that don't declare the key get the stock template.
- **Tests** (`tests/run-tests.sh`, 54/54 pass): the template path resolves
  inside the project root, the stock template is used when the key is absent,
  and `..` is rejected.

`mise run deploy-preflight` reads the platform checkout. It **fails** when
the nginx role has no `site_template` support, when the systemd template has
no `LoadCredential=`, or when the checkout is missing.
`mise run deploy-check` only warns about a missing checkout. A deploy on a
platform without the branch would silently render the stock site (chat
broken) and drop every secret.

## What the site does

- **TLS** on the VPS (no Cloudflare). HTTP returns 301 to `https://cuencada.com`,
  except `/.well-known/acme-challenge/`, which certbot renewals need. `www`
  returns 301 to the apex: CORS and the CSRF Origin check allow one origin
  only.
- **Headers on every static response:** the CSP, verbatim from csp.md with the
  bucket filled in, plus HSTS (1 y, `includeSubDomains`), `nosniff`, `DENY`,
  `Referrer-Policy` and `Permissions-Policy`.
  - `add_header` doesn't inherit into a location that sets its own headers. So
    each of the three static locations (files, manifest, SPA routes) repeats
    the full set, and the preflight checks the copies are identical.
  - `Cache-Control` comes from one `map`, so no location needs a fourth set.
- **Caching:**
  - `/assets/*` and `workbox-*.js`: `public, max-age=31536000, immutable` (the
    file names are content hashes).
  - `icons/`, `images/` and `canciones/`: 1 day.
  - Everything else: `no-cache`. That covers `index.html`, `sw.js`,
    `sw-purge.js` and the manifest (served as `application/manifest+json`).
- **SPA fallback:** paths without an extension render `index.html`. A path
  with an extension is a real file or a 404.
- **`/api/`:** proxied to `127.0.0.1:3104` with the original URI. Helmet sets
  the API's own headers (stricter `no-referrer`, the API CSP,
  `Cache-Control: no-store`), and nginx adds none, so nothing is duplicated.
- **Chat:** `location = /api/chat/ws` upgrades the connection.
  - Read and send timeouts are 75 s. The server pings every 25 s, so the
    socket survives two lost pings.
  - Max 10 sockets per IP.
- **Client IP:**
  - `X-Forwarded-For` and `X-Real-IP` are set to `$remote_addr` (overwrite).
  - `X-Forwarded-Host`, `Forwarded`, `CF-Connecting-IP` and `True-Client-IP`
    are blanked, so they are never passed to the app.
- **Access log** (`cuencada_redacted`):
  - It logs method, path (no query string), status, bytes, the Referer cut at
    `?`/`#`, user agent and timings.
  - **The error log can contain query strings.** On upstream failures nginx
    quotes the whole request line (`?ticket=`, `?q=`, `?search=`). So:
    - its level stays at `error`;
    - both files are mode **0640, group `adm`** (Ubuntu's logrotate creates
      them `www-data:adm 0640`);
    - they are kept **14 days** (the Ubuntu logrotate default; don't raise
      it);
    - they are never shipped anywhere wider than the access log.

    The chat ticket is single-use and lives 30 s. See runbook § 10
    (Security L3).
- **Body size:** 1 MiB, matching Fastify's JSON limit. Photos and videos go
  straight to the bucket.
- **Backstop rate limit:** 20 r/s per IP on `/api/` (burst 60), answering
  429. The app keeps its own per-IP and per-user limits.
- **Health:**
  - `/healthz` is liveness only: it proxies `/health`, with no DB call and no
    access log.
  - `/health/ready` is not proxied. Check it over SSH:
    `curl -fsS http://127.0.0.1:3104/health/ready`.
- **Legacy URLs:**
  - `/cuencada2026.html` returns 301 to `/cuencada/2026`.
  - `/mensajes.txt`, `/mensajes.json` and `/images/fotos/*` return 301 to `/`.
  - `/index.html` is not redirected. It is the SPA shell, and Workbox
    precaches it as `/index.html?__WB_REVISION__=…`.

## Verified locally (2026-10-06)

- `nginx -t` on `nginx:1.24-alpine` (the same version as `server_1`) with a
  self-signed certificate.
- Full run, with the file adapted only for ports (8080/8443) and a fictional
  bucket:
  - the built SPA was served from `apps/web/dist`;
  - the built API ran as the least-privilege DB role;
  - `scripts/deploy-smoke.mjs` passed every check: headers, cache, SPA
    fallback, the 404 for a missing asset, the legacy redirect, login, `/me`,
    the edition, and the chat WebSocket through nginx (open 3 s).
  - `?ticket=`, `?q=`, `?search=` and a Referer query never appeared in the
    access or error log.
  - Spoofed `X-Forwarded-For`, `CF-Connecting-IP` and `Forwarded` headers never
    reached the API.
