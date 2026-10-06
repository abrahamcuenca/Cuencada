# Cutover runbook: first production deploy of cuencada.com

WP-2.4 · Tech Lead · 2026-10-06. Decisions and open questions are in
[`WP-2.4.md`](../coordination/WP-2.4.md). The nginx details are in
[`nginx.md`](nginx.md).

**Who does what**

- **O** = owner. Holds the vault, SSH, DNS, the Linode and Resend accounts,
  and approves deploys.
- **A** = agent. Prepares, verifies and reviews. Never deploys and never
  touches production data.
- Every step that mutates production is **O, with explicit approval**.

**Shape of production**

- **Runtime:** Ubuntu 24.04 `server_1`, nginx 1.24, Node 24.
- **Database:** PostgreSQL 18, reached from the operator's machine through an
  SSH tunnel.
- **Media:** a Linode Object Storage bucket in `us-southeast-1`.
- **Email:** Resend.
- **No Cloudflare:** DNS points straight at `server_1`.
- **Deploy:** Acleron bundle mode. The build, migrations and verify run on the
  operator's machine, and the VPS only runs `pnpm install --prod`.

---

## 0. Pre-launch gates (must be closed or explicitly waived by O)

| Item | Status | Owner |
|---|---|---|
| Home mosaic replaced, so there are no public family photos (CUTOVER GATE) | Done in #34 | — |
| Stricter open invites: 5/10 uses, 72 h, admin alert per acceptance (threat model A2) | Done in #36 | — |
| **Breached-password check** on set, change and reset (WP-2.3 L5, ASVS 2.1.7) | **Open.** Backend WP before launch, or O waives it in writing | O decides |
| Threat model updated for #35/#36 and WP-2.4 | Done in WP-2.4 | — |
| WP-2.3 open findings: L1 (zod `jitless`, web), L4 (CI image digest) | Low. Not blocking, backlog | — |
| **Platform change**: Acleron renders `nginx.site_template` ([nginx.md](nginx.md)) | **Open.** `deploy-preflight` fails until it lands | O (platform repo) |
| Bucket name filled in (`<bucket>` in `infra/project.yml` ×2 and `infra/nginx/cuencada.conf` ×9) | **Open** | O gives the name; A edits it in a PR |
| Video cap 150 MB (server_1 RAM, decision D6 in WP-2.4) | Done in WP-2.4 | — |
| Minimum client version mechanism (force-update stale PWAs) | **Open** (backlog WP-2.x). Not needed for the first deploy: there are no old clients yet | — |

## 1. Pre-flight (no production changes)

1. **A/O:** from a clean checkout of `main` on the operator's machine
   (Linux x86_64; `build-bundle.sh` refuses anything else):
   ```sh
   pnpm install --frozen-lockfile
   mise run verify            # lint, typecheck, tests (podman Postgres), prod audit
   mise run deploy-check      # preflight + production build + check:sw + bundle size
   ```
   - `deploy-check` needs no secret and no SSH.
   - It fails while the bucket name is a placeholder, or while the platform
     can't render the project's nginx site.
   - Set `ACLERON_PLATFORM_DIR` if the platform isn't checked out at
     `../acleron-platform/acleron-platform`.
2. **O:** port check. Read-only. 3104 was free on 2026-10-06, and the
   cuencada service doesn't exist yet.
   ```sh
   cd ../acleron-platform/acleron-platform && ansible-playbook -i ansible/inventory.ini \
     ansible/playbooks/ports.yml -e vps=server_1 -e range_start=3100 -e range_end=3199
   ```
3. **O:** memory check on `server_1`: `free -m`.
   - Facts on 2026-10-06: **961 MB total**, 76 MB `MemFree`, and nine other
     Node services. That is why the video cap is now 150 MB.
   - The API needs about 400 MB of headroom (systemd `MemoryHigh=400M`,
     `MemoryMax=550M`). If `available` is below about 450 MB:
     - add swap (`fallocate -l 1G /swapfile`, …), or
     - move to a 2 GB plan before launch.
   - Record the number in WP-2.4.md.
4. **O:** vault values in `~/.acleron/vault-server_1.yml`. Generate every
   secret as hex or alphanumeric only (`openssl rand -hex 32`). systemd treats
   `%` in `Environment=` as a specifier, and URLs need no escaping that way.

   | Vault key | Used by | Value |
   |---|---|---|
   | `vault_cuencada_database_url` | VPS (`DATABASE_URL`) | `postgresql://cuencada_app:<app pw>@<db host>:5432/cuencada`, the **runtime** role |
   | `vault_cuencada_jwt_secret` | VPS | `openssl rand -hex 48` (at least 32 chars) |
   | `vault_cuencada_resend_api_key` | VPS | Resend API key, **sending access, cuencada.com domain only** |
   | `vault_cuencada_s3_access_key_id` / `vault_cuencada_s3_secret_access_key` | VPS | Linode **limited** access key: read/write on the media bucket only |
   | `vault_cuencada_migrate_database_url` | operator only | `postgresql://cuencada_owner:<owner pw>@127.0.0.1:15432/cuencada`, the **owner** role through the tunnel |
   | `vault_cuencada_seed_admin_temp_password` | operator only | at least 16 chars, passes the password policy |
   | `vault_cuencada_seed_whatsapp_url`, `…_external_album_url`, `…_lyrics_url`, `…_program_url` | operator only | the **new** links from step 2 |

   `mise run deploy-preflight` prints the list of keys `infra/project.yml`
   references. It never reads the values.
5. **O:** DNS.
   - `cuencada.com` and `www.cuencada.com` A records point at `server_1`.
     Both already did on 2026-10-06.
   - No AAAA record unless nginx listens on IPv6 (it doesn't).
   - Today `https://cuencada.com` answers with another site's certificate
     (`acleron.com`), because there is no cuencada vhost yet. The first deploy
     issues the Let's Encrypt certificate with certbot (HTTP-01 on port 80).
6. **O:** Resend domain verified (§ Resend below). The status is "Verified"
   for SPF and DKIM.
7. **O:** bucket created, private, with CORS and lifecycle applied, and the
   real-bucket check passing (§ Bucket below).
8. **O:** DB roles created (§ Database roles below), and the tunnel works:
   `pg_isready -h 127.0.0.1 -p 15432`.
9. **O:** systemd drop-in ready to install (step 4).

## 2. Rotate the legacy links (before seeding)

The WhatsApp group invite and the OneDrive share links are public. They are
in the legacy `index.html` and `cuencada2026.html`, and in git history. Git
history is not rewritten (owner decision), so the old links must die.

1. **O:** WhatsApp → group → Invite via link → **Reset link**. The old link
   stops working immediately.
2. **O:** OneDrive → each shared item (album, song lyrics, program) → Manage
   access → **remove the existing "Anyone with the link" links** → create new
   ones (view only, and an expiry if wanted).
3. **O:** put the four new URLs in the vault
   (`vault_cuencada_seed_*_url`). Never in the repo, a ticket or chat.
4. **A** (WP-2.4, done): `apps/server/src/seed-data.ts` no longer contains the
   legacy links. Development uses `example.com` placeholders, and **the
   production seed refuses to run unless all four `SEED_*_URL` are set**.

## 3. Database roles (once, O)

[`infra/db/roles.sql`](../../infra/db/roles.sql) creates two roles:

- **`cuencada_owner`** owns the database, schema `public` and every table.
  - It is used only by the migrator, as `MIGRATE_DATABASE_URL`, from the
    operator's machine through the tunnel.
  - It is never on the VPS.
- **`cuencada_app`** is the runtime role, `DATABASE_URL` on the VPS.
  - It gets `SELECT`/`INSERT`/`UPDATE`/`DELETE` on the app tables and
    sequence usage.
  - Default privileges cover every future table the owner creates.
  - It gets no DDL, no `TRUNCATE`, no temp tables, and no access to the
    migrator's `drizzle` schema.
  - `statement_timeout` is 30 s, `idle_in_transaction_session_timeout` 60 s,
    and the connection limit 30.

```sh
# as the postgres superuser, on the DB host (or through the tunnel as a superuser)
psql -v ON_ERROR_STOP=1 -v db_name=cuencada -v owner_role=cuencada_owner -v app_role=cuencada_app \
     -v owner_password="$(cat owner.pw)" -v app_password="$(cat app.pw)" \
     -d postgres -f infra/db/roles.sql
```

- Re-running the script is safe: it resets the passwords and repeats the
  grants.
- `pg_hba.conf` must allow `cuencada_app` from `server_1` and
  `cuencada_owner` from the tunnel endpoint only, with `scram-sha-256`.
- **Proof:** [`infra/db/verify-roles.sh`](../../infra/db/verify-roles.sh)
  runs the whole cycle against the disposable podman Postgres. It migrates as
  the owner, then seeds, serves and smoke-tests as the runtime role, and
  checks that DDL, `TRUNCATE`, temp tables and the drizzle schema are denied
  (see WP-2.4.md).

## 4. Deploy (O, explicit approval)

```sh
db &                                                        # the SSH tunnel to Postgres (127.0.0.1:15432)
export MIGRATE_DATABASE_URL='<vault_cuencada_migrate_database_url>'   # OWNER role, tunnel host:port
mise run deploy
unset MIGRATE_DATABASE_URL
```

What runs, in order:

1. `deploy-preflight` fails fast on config drift.
2. `build-bundle.sh` runs:
   - `mise run verify`;
   - `pnpm turbo build` with `build_env`;
   - **migrate**: `node apps/server/dist/db/migrate.js` against
     `MIGRATE_DATABASE_URL`. The script refuses any host:port other than
     `deploy.migrate_tunnel`. A failed migration ships nothing.
   - pack the bundle.
3. Ansible does the rest:
   - upload, then `pnpm install --prod --frozen-lockfile --filter @cuencada/server...`
     on the VPS. Native argon2 and sharp come from the lockfile's linux-x64
     glibc prebuilds; see WP-2.4 D7.
   - swap the `current` symlink and rsync the SPA to `/srv/cuencada/web/current`;
   - render the systemd unit, then restart and wait for `is-active`;
   - certbot (first run only), then the nginx site, `nginx -t` and a reload.

The seed is **not** part of the deploy.

**First deploy only, right after it (O, on `server_1`):** install the systemd
hardening drop-in. Acleron never touches the drop-in directory, so this is
done once.

```sh
sudo install -D -m 0644 cuencada-server.service.d/override.conf \
     /etc/systemd/system/cuencada-server.service.d/override.conf   # from infra/systemd/
sudo systemctl daemon-reload && sudo systemctl restart cuencada-server
systemctl show cuencada-server -p MemoryHigh -p MemoryMax -p NoNewPrivileges -p ProtectSystem
sudo systemd-analyze security cuencada-server
```

**Health right after every deploy (O):**

```sh
curl -fsS https://cuencada.com/healthz                     # liveness through nginx: {"ok":true,...}
ssh server_1 'curl -fsS http://127.0.0.1:3104/health/ready' # DB reachable as the runtime role: "db":true
ssh server_1 'journalctl -u cuencada-server -n 50 --no-pager'
```

If `/health/ready` reports `db:false`, check, in order:

1. the `DATABASE_URL` vault value;
2. `pg_hba.conf`;
3. the role grants (`\dp` as the owner).

## 5. Rollback

- **Code:**
  ```sh
  ssh server_1
  ls -dt /srv/cuencada/releases/*/
  sudo ln -sfn /srv/cuencada/releases/<previous> /srv/cuencada/current
  sudo systemctl restart cuencada-server
  sudo rsync -a --delete /srv/cuencada/current/apps/web/dist/ /srv/cuencada/web/current/
  ```
  The last 3 releases are kept.
- **Schema:** migrations are expand-only (0002 on), so the previous code runs
  on the new schema and there is no down-migration. If a migration itself is
  wrong, write a forward fix. Never edit the `drizzle` bookkeeping by hand.
- **First deploy gone wrong:**
  ```sh
  sudo systemctl stop cuencada-server
  sudo rm /etc/nginx/sites-enabled/cuencada
  sudo systemctl reload nginx
  ```
  The domain falls back to the host's default site, as before the cutover.
  Nothing else on `server_1` is touched.
- **nginx:**
  ```sh
  sudo nginx -t
  sudo cp /etc/nginx/sites-available/cuencada{,.bad}
  ```
  Then redeploy, or reinstall the last good `infra/nginx/cuencada.conf`.

## 6. One-time production seed (O, over the tunnel, after the first migration)

It runs from the operator's checkout, after `pnpm build`, through the same
tunnel and owner-role URL as the migration (the seed only inserts rows; the
runtime role's grants were proven by `infra/db/verify-roles.sh`). The values
come from the vault and live in this shell only.

```sh
db &
export MIGRATE_DATABASE_URL='<vault_cuencada_migrate_database_url>'
NODE_ENV=production \
DATABASE_URL="$MIGRATE_DATABASE_URL" \
SEED_ADMIN_EMAIL=admin@cuencada.com \
SEED_ADMIN_TEMP_PASSWORD='<vault_cuencada_seed_admin_temp_password>' \
SEED_WHATSAPP_URL='<new link>' \
SEED_EXTERNAL_ALBUM_URL='<new link>' \
SEED_LYRICS_URL='<new link>' \
SEED_PROGRAM_URL='<new link>' \
node apps/server/dist/seed.js
```

- **Expected output:** `seed: done {"adminCreated":true,…,"announcementsCreated":2,…}`.
- **All four links are required.** The seed fails and names the missing
  variables otherwise. Links reach the edition row only on its first insert.
  A later re-run never overwrites them; change them in the admin UI instead.
- With `NODE_ENV=production`, the seed refuses a missing, weak (< 16 chars)
  or placeholder password.
- The admin is created with `must_change_password = true` and an
  **unverified email**.
- Afterwards: `unset MIGRATE_DATABASE_URL`, `history -d` the lines (or use a shell with `HISTCONTROL=ignorespace`
  and a leading space), and `unset` the variables.

**First admin login (O, in the browser):**

1. Open `https://cuencada.com/entrar` and log in as `admin@cuencada.com` with
   the temporary password.
2. You are forced to the change-password screen. Set a new password and keep
   it in a password manager.
3. **Verify the email:** request the verification email from the prompt and
   click the link. `admin@cuencada.com` must be a real, monitored mailbox:
   chat and the gallery stay at 403 `EMAIL_UNVERIFIED` until then.

## 7. Smoke tests (O, A can read the output)

```sh
SMOKE_BASE_URL=https://cuencada.com SMOKE_EMAIL=admin@cuencada.com SMOKE_PASSWORD='<new password>' \
  node scripts/deploy-smoke.mjs
```

The smoke test checks:

- `/healthz`;
- the CSP and security headers on `/`, `sw.js` and a hashed asset;
- `no-cache` and `immutable` caching;
- the SPA fallback, and a 404 for a missing asset;
- the legacy redirect;
- login, `/api/me` (`no-store`) and `/api/cuencadas/2026`;
- a chat ticket plus a **WebSocket through nginx** that stays open.

It prints no secret.

Then, by hand:

- **Upload:** upload a photo on `/galeria/2026` from a phone, and from a
  desktop with a > 40 MP image (resize worker). The item must reach "ready",
  and the photo must have no EXIF/GPS (`exiftool` on the downloaded display
  copy).
- **CSP report:** DevTools → Console on `/`, `/galeria/2026` and `/chat`. The
  only expected entry is the zod `eval` probe (WP-2.3 L1, until
  `z.config({ jitless: true })` lands). Anything else is a regression; run
  `node docs/security/csp-check.mjs` locally.
- **Email:** request a password reset for a test account. The mail arrives
  from `no-reply@cuencada.com`, and the headers show `spf=pass`, `dkim=pass`
  and `dmarc=pass`.
- **Logs:** `sudo tail /var/log/nginx/cuencada-access.log` shows paths
  without query strings. `journalctl -u cuencada-server` shows
  `ticket=[REDACTED]`.
- **TLS:** `curl -sI http://cuencada.com` returns 301 to https, and
  `curl -sI https://www.cuencada.com` returns 301 to the apex. Check the
  certificate SAN covers both names, and the HSTS header is present.

## 8. Retire the legacy site

**How it's deployed today:** it isn't.

- `cuencada.com` resolves to `server_1`, but there is no cuencada vhost, so
  nginx answers with the host's default site: `acleron.com`'s page and
  certificate.
- `/cuencada2026.html` and `/mensajes.txt` return 404.
- There is no GitHub Pages site (API 404).

So the only places the legacy files still live are **the repo and its history**.

1. **A** (done): nginx redirects the old URLs, in case anyone kept a link:
   - `/cuencada2026.html` → `/cuencada/2026`;
   - `/mensajes.txt`, `/mensajes.json` and `/images/fotos/*` → `/`.

   `/index.html` stays the SPA shell; see [nginx.md](nginx.md).
2. **A** (follow-up PR after the cutover is green): `git rm` the root
   `index.html`, `cuencada2026.html`, `images/` (including `images/fotos`),
   `mensajes.json` and `canciones/`. Keep `mensajes.txt` until the seed no
   longer reads it, or move it under `apps/server/`. The new app already
   serves its own copies from `apps/web/public/`.
   - Also update the Biome ignore list, AGENTS.md ("Repo Shape") and
     `.gitignore`.
   - History stays (owner decision: sweep forward, no rewrite). The rotated
     links make the history copies harmless.
3. **O:** nothing to remove on the server.

## 9. PWA

- `mise run deploy-check` runs `check:sw`, so the service worker never caches
  private `/api/**`.
- nginx serves `sw.js`, `sw-purge.js`, `index.html` and the manifest with
  `no-cache`. Open tabs check for a new worker hourly and show the
  "Actualizar" prompt.
- **Minimum client version** (backlog): until a server-driven minimum version
  exists, a security fix reaches PWA users only when they accept the update
  prompt or reload. See the release checklist (§ 11).

## 10. Observability

Logs reach journald and then Loki:

- **API:** Pino JSON on stdout. The unit has `StandardOutput=journal`,
  `SyslogIdentifier=cuencada-server`.
- **Shipping:** the host's Grafana Alloy or promtail ships journald to Loki
  with `unit="cuencada-server.service"`. If the host doesn't ship journald
  yet, add the unit to its journal scrape. That is O's monitoring stack.
- **nginx:** `/var/log/nginx/cuencada-{access,error}.log`.

Alert rules (Grafana, LogQL):

| Alert | Query | Condition |
|---|---|---|
| Daily email cap reached | `count_over_time({unit="cuencada-server.service"} \| json \| event="mail.cap_reached" [15m])` | > 0 |
| Mail queue full (emails dropped) | `count_over_time({unit="cuencada-server.service"} \| json \| event="mail.queue_full" [5m])` | > 0 |
| Admin/invite alert caps | `count_over_time({unit="cuencada-server.service"} \| json \| event=~"mail.(admin_alert\|invite_alert)_cap_reached" [1h])` | > 0 |
| Process restarts / crash loop | `count_over_time({unit="cuencada-server.service"} \|= "Main process exited" [10m])` (systemd's own line) or `{syslog_identifier="systemd"} \|= "cuencada-server.service: Scheduled restart job"` | ≥ 1 warn, ≥ 3 page |
| OOM kill | `{syslog_identifier="kernel"} \|= "oom-kill" \|= "cuencada-server"` | > 0 |
| Fatal / failed start | `{unit="cuencada-server.service"} \| json \| level >= 50` | > 0 |
| Chat at capacity | `{unit="cuencada-server.service"} \|= "chat socket refused: at capacity"` | > 0 |
| 5xx rate (nginx) | `sum(count_over_time({filename="/var/log/nginx/cuencada-access.log"} \|~ "\" 5\\d\\d " [5m]))` | > 10 |

Pino levels are numeric: 50 = error, 60 = fatal. The log scrubber already
redacts tokens, cookies and query values; never add a raw request dump.

## 11. Release checklist (every later deploy)

1. `main` is green in CI. `mise run verify` and `mise run deploy-check` pass
   locally.
2. Every new migration is **expand/contract**: the code currently live must
   work on the new schema, because migrations run before the new code. Check
   for drops, renames, `NOT NULL` without a default, and narrowed CHECKs.
3. New config key? Map it in `infra/project.yml` (the preflight fails
   otherwise), and add it to the vault when it's a secret.
4. Open the tunnel, export `MIGRATE_DATABASE_URL` (owner role), then
   `mise run deploy` (O approves).
5. Health (§ 4) and smoke (§ 7).
6. **Security fix?**
   - **Bump the minimum client version**, once that mechanism exists
     (backlog). It forces stale PWAs to reload instead of waiting for the
     hourly update check.
   - Until then, note the fix in the admin announcement so members reload.
   - Rotate any secret the fix concerns: `JWT_SECRET` logs everyone out;
     Resend and S3 keys are rotated in their dashboards, then the vault, then
     redeploy.
7. Record the release (commit, time, migrations) in the PR or the release
   notes.

---

## Resend DNS

Resend's dashboard is the source of truth for the exact values: Domains →
cuencada.com. Add the records at the DNS provider of `cuencada.com`:

| Type | Name | Value | Notes |
|---|---|---|---|
| TXT | `resend._domainkey` | `p=<DKIM public key from the Resend dashboard>` | DKIM. Copy it exactly |
| MX | `send` | `feedback-smtp.<region>.amazonses.com` (priority 10) | Return path (bounces). The region is shown in the dashboard |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | SPF for the return-path subdomain |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:admin@cuencada.com; adkim=r; aspf=r` | Start with `p=none`. Move to `p=quarantine` after 2 clean weeks of reports |

- `MAIL_FROM` is `Cuencada <no-reply@cuencada.com>` (in `infra/project.yml`).
  The preflight checks it sends from the project domain.
- The root domain needs no SPF change for Resend: SPF aligns through `send.`,
  and DKIM signs as `cuencada.com`. If the root already has an SPF record for
  another sender, leave it alone. Never publish two SPF records on one name.
- **Receiving mail** at `admin@cuencada.com`, the admin's verification and
  reset emails, needs the domain's own MX for a mailbox provider. That is
  separate from Resend's `send` MX. See WP-2.4's open question Q4.
- Restrict the API key to **sending only**, for the cuencada.com domain only.

## Bucket

Use `s3cmd` with the Linode endpoint. Put the credentials in a temporary
`~/.s3cfg` with mode 600, or pass `--access_key/--secret_key` from the vault.
Never commit them. `B=<bucket>`:

```sh
S3="s3cmd --host=us-southeast-1.linodeobjects.com --host-bucket=%(bucket)s.us-southeast-1.linodeobjects.com"
$S3 mb s3://$B                                   # if not created in the Linode console
$S3 setacl s3://$B --acl-private                 # private: objects are reachable only via presigned URLs
$S3 setcors infra/bucket/cors.xml s3://$B        # PUT/GET/HEAD from https://cuencada.com, content-type only
$S3 setlifecycle infra/bucket/lifecycle.xml s3://$B   # abort incomplete multipart uploads after 1 day
$S3 info s3://$B                                 # shows the CORS and policy
$S3 getlifecycle s3://$B
```

With the AWS CLI instead:

```sh
aws --endpoint-url https://us-southeast-1.linodeobjects.com s3api put-bucket-cors --bucket "$B" --cors-configuration file://infra/bucket/cors.json
```

The lifecycle has **no expiration rule**. Originals are written straight to
`cuencadas/<year>/originals/`, where accepted originals also live, so a
prefix expiry would delete real photos. The app's cleanup job handles
orphans. If the backlog's `incoming/` prefix ever lands, add an expiration
rule for it then.

**Real-bucket check (O):** the bucket must reject a PUT whose length or type
differs from what was signed. It must also refuse unsigned reads, and allow
CORS only from the app origin:

```sh
pnpm build
S3_ENDPOINT=https://us-southeast-1.linodeobjects.com S3_REGION=us-southeast-1 S3_BUCKET=$B \
S3_ACCESS_KEY_ID='<vault>' S3_SECRET_ACCESS_KEY='<vault>' \
node infra/bucket/check-presigned-put.mjs
```

It writes one 1 KB object under `_preflight/`, deletes it, and expects:

- longer body → 403;
- other type → 403;
- control → 200;
- unsigned GET → 403;
- CORS from `https://cuencada.com` allowed, foreign origin refused.

## Runtime notes

- **Native modules (argon2, sharp):** the VPS installs them itself (`pnpm install --prod`).
  - argon2 0.44 ships `linux-x64` glibc prebuilds, and its install script
    (allowed in `pnpm-workspace.yaml`) falls back to `node-gyp`, which
    `build-essential` (Acleron's base role) can run.
  - sharp 0.35 installs `@img/sharp-linux-x64` and `@img/sharp-libvips-linux-x64`,
    which need glibc ≥ 2.26. Ubuntu 24.04 has 2.39, the same as the build
    machine.
  - Check after the first deploy:
    ```sh
    cd /srv/cuencada/current/apps/server && sudo -u svc_cuencada node -e "require('argon2'); require('sharp'); console.log('native modules ok')"
    ```
    `/health/ready` plus a login (argon2) and a photo upload (sharp) prove it
    too.
- **Threadpool:**
  - `UV_THREADPOOL_SIZE=6` is set in `infra/project.yml`. argon2 hashing,
    sharp's async work and DNS/fs all share libuv's pool, which defaults to
    4. WP-2.2 saw a caption save take about 13 s while images processed.
  - sharp is already `concurrency(1)` with no cache (`mediaProcess.ts`).
    Avatars process at most 2 at a time.
  - Don't raise the pool further on a 1-vCPU host: it adds memory, not
    throughput.
- **Memory:** see step 1.3 and the drop-in.
  - The video cap is 150 MB: one video job holds the whole file until
    storage streaming lands (backlog).
  - If OOM kills show up in the alerts, the next steps are swap, a 2 GB plan,
    or the streaming storage work.
