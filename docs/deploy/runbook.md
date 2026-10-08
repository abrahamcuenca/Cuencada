# Cutover runbook: first production deploy of cuencada.com

WP-2.4 · Tech Lead · 2026-10-06, revised after the PR #38 review, and again
after the first production deploy and seed on **2026-10-07** (WP-3.2).
Decisions and open questions are in [`WP-2.4.md`](../coordination/WP-2.4.md).
The nginx details are in [`nginx.md`](nginx.md).

**Who does what**

- **O** = owner. Holds the vault, SSH, DNS, the Linode and Resend accounts,
  and approves deploys.
- **A** = agent. Prepares, verifies and reviews. Never deploys and never
  touches production data.
- Every step that mutates production is **O, with explicit approval**.

**Shape of production**

- **API:** Ubuntu 24.04 `server_1` (resized to **2 GB** before launch),
  nginx 1.24, Node 24.
- **Database:** PostgreSQL 18 on a **separate DB server**:
  - `server_1` reaches it over the private VPC at `<DB_VPC_HOST>:5432`. The
    address is owner-provided and only lives in the vault URL.
  - The operator reaches it from their machine through an SSH tunnel on
    `127.0.0.1:${TUNNEL_PORT}`. That port must equal `deploy.migrate_tunnel`
    in `infra/project.yml` (15432 today).
- **Media:** a Linode Object Storage bucket in `us-east-1`.
- **Email:** Resend.
- **No Cloudflare:** DNS points straight at `server_1`.
- **Deploy:** Acleron bundle mode, with the platform's `nginx.site_template`
  and `server.credentials` (branch `cuencada-nginx-credentials`, now merged
  into the platform). Build, verify and migrations run on the
  operator's machine, and the VPS only runs `pnpm install --prod`.
- **Secrets:** they are not in the unit's `Environment=` lines. Each one is a
  root-only file in `/etc/credstore/cuencada-server/`, loaded with
  `LoadCredential=`, and the API reads it from `$CREDENTIALS_DIRECTORY`.

**Shell hygiene for every secret below (Security L1):**

- Paste secrets into `read -rs`, which never echoes them and keeps them out
  of shell history. Print the prompt with `printf` first.
- Never put a secret on a command line or in a file inside the repo.
- `unset` each one when done.

```sh
printf 'paste <name>: '; read -rs VAR; echo
# … use "$VAR" …
unset VAR
```

**Shell compatibility:** every snippet works in both zsh and bash. Don't use
`read -rsp 'prompt: ' VAR`: in zsh `-p` means "read from the coprocess" and
fails with `read: -p: no coprocess` (it broke the first seed).

---

## 0. Pre-launch gates (must be closed or explicitly waived by O)

Launched on 2026-10-07 with every gate below closed or explicitly deferred by O.

| Item | Status | Owner |
|---|---|---|
| Home mosaic replaced, so there are no public family photos (CUTOVER GATE) | Done in #34 | — |
| Stricter open invites: 5/10 uses, 72 h, admin alert per acceptance (threat model A2) | Done in #36 | — |
| **Breached-password check** on set, change and reset (WP-2.3 L5, ASVS 2.1.7) | Done in WP-2.3c (#39). Needs egress to `api.pwnedpasswords.com` (§ 1 step 10) | — |
| Threat model updated for #35/#36 and WP-2.4 | Done in WP-2.4 | — |
| WP-2.3 open findings: L1 (zod `jitless`, web), L4 (CI image digest) | Low. Not blocking, backlog | — |
| **Acleron platform:** `nginx.site_template` and `server.credentials`, branch `cuencada-nginx-credentials` (head `46d71eb`, tests 66/66, Security and TL approved) | Done: merged into the platform | — |
| Bucket name and region in `infra/project.yml` and the `infra/nginx/cuencada.conf` CSP | Done: `cuencada` in `us-east-1` | — |
| `server_1` resized to 2 GB | Done | — |
| Legacy WhatsApp/OneDrive links rotated (§ 2) | **Deferred by O.** The seed used the existing links. Rotate later, then update them in Panel → edit the 2026 edition. Accepted risk A10 in the threat model | O |
| Video cap 150 MB (it can return to 300 MB after the resize; see the runtime notes) | Done in WP-2.4 | — |
| Minimum client version mechanism (force-update stale PWAs) | **Open** (backlog WP-2.x). Not needed for the first deploy: there are no old clients yet | — |

## 1. Pre-flight (no production changes)

1. **A/O:** from a clean checkout of `main` on the operator's machine
   (Linux x86_64; `build-bundle.sh` refuses anything else):
   ```sh
   pnpm install --frozen-lockfile
   mise run verify            # lint, typecheck, tests (podman Postgres), prod audit
   mise run deploy-check      # preflight + production build + check:sw + bundle size
   ```
   - `deploy-check` needs no secret and no SSH. A missing Acleron checkout
     only warns there.
   - `mise run deploy-preflight` is the strict version, and it runs again
     inside `build-bundle` and `deploy`. It **fails** when any of these is
     true:
     - the Acleron checkout is missing;
     - the checkout lacks `site_template` or `LoadCredential=` support;
     - the bucket is still a placeholder;
     - anything drifted.
   - Point `ACLERON_PLATFORM_DIR` at the platform if it isn't at
     `../acleron-platform/acleron-platform`. That checkout must be on the
     platform's `main`, which now includes `cuencada-nginx-credentials`.
2. **O:** systemd version on `server_1`, read-only: `ssh server_1 systemctl --version | head -1`.
   It must be **≥ 247** for `LoadCredential=`. Ubuntu 22.04 ships 249 and
   24.04 ships 255. The platform also asserts it at deploy time whenever
   `server.credentials` is used; with an older systemd the API would start
   without its secrets.
3. **O:** port check. Read-only. 3104 was free on 2026-10-06.
   ```sh
   cd ../acleron-platform/acleron-platform && ansible-playbook -i ansible/inventory.ini \
     ansible/playbooks/ports.yml -e vps=server_1 -e range_start=3100 -e range_end=3199
   ```
4. **O: resize `server_1` to 2 GB** in the Linode console (it needs a reboot
   of the Linode). Then run `free -m`.
   - On 2026-10-06 it had 961 MB in total, with nine other Node services.
   - The drop-in's `MemoryHigh=700M`/`MemoryMax=900M` assumes 2 GB.
   - **Don't install the drop-in on the 1 GB plan.**
   - Record the new `total` and `available` in WP-2.4.md.
5. **O:** vault values in `~/.acleron/vault-server_1.yml` (`ansible-vault edit`).
   - Generate every secret as hex: `openssl rand -hex 32`.
   - The five VPS secrets go to `server.credentials`, so they become root-only
     files. They never become `Environment=` lines.

   | Vault key | Used by | Value |
   |---|---|---|
   | `vault_cuencada_database_url` | VPS credential `DATABASE_URL` | `postgresql://cuencada_app:<app pw>@db.cuencada.internal:5432/cuencada?sslmode=verify-full`: the **runtime** role over the VPC, with the server certificate verified (§ 3; fallback `@<DB_VPC_HOST>…?sslmode=require`). If it uses the admin role instead of `cuencada_app`, that is accepted risk A11 (§ 3) |
   | `vault_cuencada_jwt_secret` | VPS credential | `openssl rand -hex 48` (at least 32 chars) |
   | `vault_cuencada_resend_api_key` | VPS credential | Resend API key: **sending access, cuencada.com domain only** |
   | `vault_cuencada_s3_access_key_id` / `vault_cuencada_s3_secret_access_key` | VPS credentials | Linode **limited** key: read/write on this bucket only (§ Bucket) |
   | `vault_cuencada_migrate_database_url` | operator only | `postgresql://<owner role>:<owner pw>@127.0.0.1:${TUNNEL_PORT}/cuencada`: the production `cuencada` database through the tunnel, as `cuencada_owner` or an existing admin role (§ 3). Always `127.0.0.1`, never `localhost` (§ 4) |
   | `vault_cuencada_seed_admin_temp_password` | operator only | at least 16 chars, passes the password policy |
   | `vault_cuencada_seed_whatsapp_url`, `…_external_album_url`, `…_lyrics_url`, `…_program_url` | operator only | the links the seed writes. Meant to be the **new** links from § 2; at launch O used the existing ones (§ 2) |

   `mise run deploy-preflight` prints the list of keys `infra/project.yml`
   references. It never reads the values.
6. **O:** DNS.
   - `cuencada.com` and `www.cuencada.com` A records point at `server_1`.
     Both already did on 2026-10-06.
   - No AAAA record: nginx doesn't listen on IPv6.
   - The first deploy issues the Let's Encrypt certificate (HTTP-01 on
     port 80). Until then, `https://cuencada.com` shows `acleron.com`'s
     certificate.
7. **O:** Resend domain verified (§ Resend DNS). The status is "Verified" for
   SPF and DKIM.
8. **O:** bucket created, private, with CORS and lifecycle applied, and the
   real-bucket check passing (§ Bucket).
9. **O:** DB roles, `pg_hba` and TLS done (§ 3), and the tunnel works:
   ```sh
   ssh -N -L ${TUNNEL_PORT}:127.0.0.1:5432 <db server> &   # see § 3 for the alternative through server_1
   pg_isready -h 127.0.0.1 -p ${TUNNEL_PORT}
   ```
10. **O:** egress from `server_1` to the breached-password API (WP-2.3c),
    read-only. The API sends only a 5-character SHA-1 prefix to
    `https://api.pwnedpasswords.com/range/<prefix>`:
    ```sh
    ssh server_1 'curl -sS -o /dev/null -w "%{http_code}\n" --max-time 5 \
      -H "Add-Padding: true" -H "User-Agent: cuencada" https://api.pwnedpasswords.com/range/21BD1'
    ```
    - Expect `200`. The firewall must allow outbound HTTPS (443) to that host
      (Cloudflare-fronted, so allow by hostname or allow 443 egress). nginx
      needs no change: the call is server-side and not proxied.
    - If it is blocked, nothing breaks: the check **fails open** and logs
      `password.breach_check_unavailable` (alert in § 10). But the check is
      then effectively off, so fix egress before launch.
    - The one-off seed (§ 6) runs the same check from the operator's machine
      and needs the same egress (or `PASSWORD_BREACH_CHECK=off` for that run,
      with a freshly generated password).

## 2. Rotate the legacy links (before seeding)

The WhatsApp group invite and the OneDrive share links are public. They are
in the legacy `index.html` and `cuencada2026.html`, and in git history. Git
history is not rewritten (owner decision), so the old links must die.

**Launch status (2026-10-07): deferred by O.** The seed ran with the existing
links. Until they are rotated, that is accepted risk A10 in the
[threat model](../security/threat-model.md). To rotate later, do steps 1
and 2, then paste the new links into **Panel → edit the 2026 edition**. The
seed only writes links on the edition's first insert, so re-running it
changes nothing; step 3 only matters for a fresh database.

1. **O:** WhatsApp → group → Invite via link → **Reset link**.
2. **O:** OneDrive → each shared item (album, song lyrics, program) → Manage
   access → **remove the existing "Anyone with the link" links** → create new
   ones (view only, and an expiry if wanted).
3. **O:** put the four new URLs in the vault (`vault_cuencada_seed_*_url`).
   Never in the repo, a ticket or chat.
4. **A** (WP-2.4, done): `seed-data.ts` no longer contains the legacy links,
   and **the production seed refuses to run unless all four `SEED_*_URL` are
   set**.

## 3. Database: roles, network, TLS (once, O, on the DB server)

[`infra/db/roles.sql`](../../infra/db/roles.sql) creates two roles.

The owner/migrator doesn't have to be `cuencada_owner`. It can be an
**existing admin role**, such as the platform's DB admin role (that is what
the launch used). Pass it as `-v owner_role=<that role>`: the script creates
a role only when it is missing, never alters an existing one, and grants
`cuencada_app` DML on that owner's tables.

- **`cuencada_owner`** owns the database, schema `public` and every table.
  - It is used only by the migrator and the one-off seed, from the
    operator's machine through the tunnel.
  - It is **never** on the VPS.
- **`cuencada_app`** is the runtime role, `DATABASE_URL` on the VPS, over the
  VPC.
  - It gets DML on the app tables, sequence usage, and default privileges for
    future tables.
  - It gets no DDL, `TRUNCATE`, temp tables, or `drizzle` schema.
  - `statement_timeout` is 30 s, `idle_in_transaction_session_timeout` 60 s,
    and the connection limit 30.

The script takes **no passwords** (Security L2). Set them with `\password`,
which prompts without echo and sends only a SCRAM-SHA-256 verifier:

```sh
sudo -u postgres psql -v ON_ERROR_STOP=1 -v db_name=cuencada -v owner_role=cuencada_owner \
     -v app_role=cuencada_app -d postgres -f roles.sql      # copied from infra/db/
sudo -u postgres psql -d postgres
postgres=# \password cuencada_owner
postgres=# \password cuencada_app
```

- Until a password is set, the roles can't log in (they fail closed).
- **Non-interactive alternative:** compute the verifier on your machine with
  `printf 'password: '; read -rs PW; echo; printf '%s' "$PW" | node infra/db/scram-verifier.mjs; unset PW`,
  then run `ALTER ROLE cuencada_app PASSWORD 'SCRAM-SHA-256$4096:…';`.
- **Never** run `ALTER ROLE … PASSWORD '<plain>'`, and never pass passwords
  as `psql -v` arguments: they would land in history, `ps` and the server log.

**Runtime role on the admin role (accepted risk A11).** If the runtime
`DATABASE_URL` uses that same admin role instead of the least-privilege
`cuencada_app`, the API runs with DDL rights, and a compromised `server_1`
holds the admin password. Record it in WP-2.4.md and follow up (backlog
"Post-launch"):

1. Run `roles.sql` with `-v owner_role=<that role>`, then set the
   `cuencada_app` password as above.
2. Allow `cuencada_app` in `pg_hba` (below), switch
   `vault_cuencada_database_url` to `cuencada_app`, redeploy, and check
   `/health/ready` (§ 4).

**Network and auth.** The platform may already manage `postgresql.conf` and
`pg_hba.conf` on the DB server (it did at launch). Then the lines below are
guidance to **verify** against what is there, not a required edit. In
`postgresql.conf`:

```ini
listen_addresses = 'localhost,<DB_VPC_HOST>'   # never a public interface
password_encryption = scram-sha-256
ssl = on                                       # recommended: TLS on the VPC too
ssl_cert_file = '…'  ssl_key_file = '…'        # a self-signed or private-CA cert is fine
```

In `pg_hba.conf`, put these lines **first** for this database, and remove any
broader line that would also match it (for example
`host all all 0.0.0.0/0 …`):

```
# TYPE    DATABASE  USER            ADDRESS                    METHOD
hostssl   cuencada  cuencada_app    <server_1 VPC IP>/32       scram-sha-256
host      cuencada  cuencada_owner  127.0.0.1/32               scram-sha-256
```

- **`cuencada_app`** is accepted only from `server_1`'s VPC address, over
  TLS. Use `host` instead of `hostssl` only if the DB has no TLS.
  - **Default: `?sslmode=verify-full`.** It encrypts the connection *and*
    authenticates the DB server. Three things are needed:
    1. **A host name, not the bare IP.** postgres.js only sends a TLS server
       name for a host name, and Node then checks the certificate against
       it. So give the DB a VPC name on `server_1`, for example an
       `/etc/hosts` line `<DB_VPC_HOST>  db.cuencada.internal`, and use
       `@db.cuencada.internal:5432` in the URL.
    2. **A DB certificate** whose SAN includes that name, issued by a private
       CA. A self-signed certificate also works when it is its own CA.
    3. **That CA's public certificate** on `server_1`, for example
       `/etc/ssl/certs/cuencada-db-ca.pem`, referenced from `server.env` as
       `NODE_EXTRA_CA_CERTS: /etc/ssl/certs/cuencada-db-ca.pem`. The preflight
       allows it. It's a path, not a secret.
  - **Fallback: `?sslmode=require`**, only if the certificate can't carry a
    usable name. It still encrypts, but doesn't authenticate the server.
    Inside the private VPC that is acceptable, not ideal. Record which one
    you chose in WP-2.4.md.
  - Neither mode was tested against the real DB (no prod access in WP-2.4).
    The first `/health/ready` after the deploy proves it.
- **`cuencada_owner`** is accepted only from the DB server's own loopback,
  which is where a tunnel lands with
  `ssh -N -L ${TUNNEL_PORT}:127.0.0.1:5432 <db server>`. The owner role is
  then unreachable from `server_1` even if `server_1` is compromised.
  - If the owner can only reach the DB through `server_1` (`ssh -N -L ${TUNNEL_PORT}:<DB_VPC_HOST>:5432 server_1`),
    the owner line must allow `<server_1 VPC IP>/32` instead. That is weaker:
    a compromised `server_1` could then try the owner password. Prefer the
    direct tunnel.
- Reload with `sudo systemctl reload postgresql`, then test from `server_1`.
  The password is pasted with `read -rs` and lives only in a temporary 0600
  `.pgpass` that is removed on exit. It never appears on a command line or in
  `ps`.
  ```sh
  umask 077; PGPASSFILE="$(mktemp)"; export PGPASSFILE; trap 'rm -f "$PGPASSFILE"' EXIT
  printf 'cuencada_app password: '; read -rs PW; echo
  printf 'db.cuencada.internal:5432:cuencada:cuencada_app:%s\n' "$PW" > "$PGPASSFILE"; unset PW
  PGSSLROOTCERT=/etc/ssl/certs/cuencada-db-ca.pem \
    psql "postgresql://cuencada_app@db.cuencada.internal:5432/cuencada?sslmode=verify-full" -c 'select 1'
  rm -f "$PGPASSFILE"; unset PGPASSFILE; trap - EXIT
  ```
  With the `require` fallback, use `<DB_VPC_HOST>` and `sslmode=require` in
  both the `.pgpass` line and the URL, and drop `PGSSLROOTCERT`.

**Proof:** [`infra/db/verify-roles.sh`](../../infra/db/verify-roles.sh) runs
the whole cycle on the disposable podman Postgres (see WP-2.4.md):

- roles without passwords, which fail closed;
- passwords set as SCRAM verifiers, then real scram-sha-256 logins;
- migration as the owner;
- the DDL, `TRUNCATE`, temp-table and drizzle denials for the runtime role;
- seed, API and smoke test as the runtime role, with its secrets read from a
  `CREDENTIALS_DIRECTORY`.

### Why migrations run through the tunnel, not on `server_1`

Migrations run on the operator's machine, through the tunnel, as the owner
role. That is the path Acleron's bundle mode already takes
(`build-bundle.sh` runs `server.migrate_command`). Running them on `server_1`
over the VPC was considered and rejected:

- **Least privilege.** Running on `server_1` would put the owner (DDL)
  credentials on the internet-facing VPS, even if only during a deploy. With
  the tunnel, `server_1` only ever holds the DML-only runtime role.
- **A failed migration ships nothing.** It fails before the bundle exists,
  while the old release keeps running. A VPS-side step would run after the
  upload, mid-deploy.
- **Guard rails already exist.** `build-bundle.sh` refuses any
  `MIGRATE_DATABASE_URL` that isn't `deploy.migrate_tunnel`, and the deploy
  refuses a bundle whose manifest says the migrations didn't run. A VPS-side
  migrate would need a new platform step with its own guards.
- **Cost:** the tunnel must be open during `mise run deploy`. That is
  acceptable for a single operator.

## 4. Deploy (O, explicit approval)

```sh
ssh -N -L ${TUNNEL_PORT}:127.0.0.1:5432 <db server> & TUNNEL=$!
printf 'owner-role URL (vault_cuencada_migrate_database_url): '; read -rs MIGRATE_DATABASE_URL; echo
export MIGRATE_DATABASE_URL
mise run deploy
unset MIGRATE_DATABASE_URL; kill $TUNNEL
```

- **`MIGRATE_DATABASE_URL`** is simply the production `cuencada` database
  through the tunnel:
  `postgresql://<owner role>:<pw>@127.0.0.1:${TUNNEL_PORT}/cuencada`. The
  owner role is `cuencada_owner` or the existing admin role (§ 3).
- **Use `127.0.0.1`, not `localhost`.** `build-bundle.sh` compares the URL's
  host and port with `deploy.migrate_tunnel` (`127.0.0.1:15432`) literally,
  so `localhost` is refused.
- **Never use `--skip-migrate`** when the release has migrations: the bundle
  would ship code for a schema the database doesn't have.
- **Arguments after `--`** go to the final `ansible-playbook` only, not to
  `build-bundle`. For example:
  `mise run deploy -- -e deploy_key_local_path=<path to the deploy key>`.
- **First deploy:** the migration creates the tables, but no account exists
  yet. The seed (§ 6) is what creates the admin account.

What runs, in order:

1. `deploy-preflight` (strict) fails fast on config drift, or on a platform
   checkout without support.
2. `build-bundle.sh` runs:
   - `mise run verify`;
   - `pnpm turbo build` with `build_env`;
   - **migrate**: `server.migrate_command`, i.e.
     `pnpm --filter @cuencada/server db:migrate` (= `node apps/server/dist/db/migrate.js`),
     against `MIGRATE_DATABASE_URL`. It refuses any host:port other than
     `deploy.migrate_tunnel`. A failed migration ships nothing.
   - pack the bundle.
3. Ansible does the rest:
   - upload, then `pnpm install --prod --frozen-lockfile --filter @cuencada/server...`
     on the VPS (native argon2 and sharp; see WP-2.4 D7);
   - swap the `current` symlink and rsync the SPA;
   - write `/etc/credstore/cuencada-server/*` (root:root 0600, `no_log`) and
     render the unit (non-secret `Environment=`, plus `LoadCredential=`);
   - restart and wait for `is-active`;
   - certbot (first run only), then the project's nginx site, `nginx -t` and
     a reload.

The seed is **not** part of the deploy.

**First deploy only (O, on `server_1`, after the 2 GB resize):** install the
hardening and memory drop-in. Acleron never touches the drop-in directory.

```sh
sudo install -D -m 0644 cuencada-server.service.d/override.conf \
     /etc/systemd/system/cuencada-server.service.d/override.conf   # from infra/systemd/
sudo systemctl daemon-reload && sudo systemctl restart cuencada-server
systemctl show cuencada-server -p MemoryHigh -p MemoryMax -p NoNewPrivileges -p ProtectSystem
sudo systemd-analyze security cuencada-server
```

**Secrets check after every deploy (O, on `server_1`; Security M1):** an
unprivileged user must see no secret.

```sh
sudo -u nobody systemctl show cuencada-server -p Environment \
  | grep -Ec 'DATABASE_URL|JWT_SECRET|RESEND_API_KEY|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY'   # must print 0
systemctl show cuencada-server -p LoadCredential   # names and /etc/credstore paths only, no values
sudo ls -la /etc/credstore/cuencada-server/        # dir drwx------ root root; files -rw------- root root
sudo stat -c '%a %U' /etc/systemd/system/cuencada-server.service   # 600 root
```

**Health after every deploy (O):**

```sh
curl -fsS https://cuencada.com/healthz                       # liveness through nginx: {"ok":true,...}
ssh server_1 'curl -fsS http://127.0.0.1:3104/health/ready'   # DB over the VPC as the runtime role: "db":true
ssh server_1 'journalctl -u cuencada-server -n 50 --no-pager'
```

If `/health/ready` reports `db:false`, check, in order:

1. the `vault_cuencada_database_url` value: the host (`db.cuencada.internal`
   in `/etc/hosts`, or `<DB_VPC_HOST>`), `sslmode` matching `hostssl`/`host`,
   and, for `verify-full`, `NODE_EXTRA_CA_CERTS` plus a certificate SAN that
   matches the host;
2. `pg_hba.conf` (`server_1`'s VPC IP);
3. the DB server's firewall on 5432, open to that IP only;
4. the role grants (`\dp` as the owner).

## 5. Rollback

- **Code:**
  ```sh
  ssh server_1
  ls -dt /srv/cuencada/releases/*/
  sudo ln -sfn /srv/cuencada/releases/<previous> /srv/cuencada/current
  sudo rsync -a --delete /srv/cuencada/current/apps/web/dist/ /srv/cuencada/web/current/
  sudo systemctl restart cuencada-server
  curl -fsS http://127.0.0.1:3104/health/ready     # must report "db":true before you call it done
  ```
  The last 3 releases are kept. The credentials and the unit belong to the
  last deploy; a code rollback doesn't change them.
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
- **nginx:**
  ```sh
  sudo nginx -t
  sudo cp /etc/nginx/sites-available/cuencada{,.bad}
  ```
  Then redeploy, or reinstall the last good rendered site.

## 6. One-time production seed (O, over the tunnel, after the first migration)

It runs from the operator's checkout, after `pnpm build`, as the owner role
through the tunnel (the seed only inserts rows). Every value is pasted with
`read -rs`, so nothing lands in history or `ps`.

```sh
ssh -N -L ${TUNNEL_PORT}:127.0.0.1:5432 <db server> & TUNNEL=$!
printf 'owner-role URL: ';           read -rs DB_URL;  echo
printf 'seed admin temp password: '; read -rs SEED_PW; echo
printf 'WhatsApp link: ';            read -rs WA;      echo
printf 'album link: ';               read -rs ALBUM;   echo
printf 'lyrics link: ';              read -rs LYRICS;  echo
printf 'program link: ';             read -rs PROGRAM; echo
NODE_ENV=production DATABASE_URL="$DB_URL" SEED_ADMIN_EMAIL=admin@cuencada.com \
  SEED_ADMIN_TEMP_PASSWORD="$SEED_PW" SEED_WHATSAPP_URL="$WA" SEED_EXTERNAL_ALBUM_URL="$ALBUM" \
  SEED_LYRICS_URL="$LYRICS" SEED_PROGRAM_URL="$PROGRAM" \
  node apps/server/dist/seed.js
unset DB_URL SEED_PW WA ALBUM LYRICS PROGRAM; kill $TUNNEL
```

- **Expected output:** `seed: done {"adminCreated":true,…,"announcementsCreated":2,…}`.
- **All four links are required.** The seed fails and names the missing
  variables otherwise. Links reach the edition row only on its first insert;
  change them later in the admin UI.
- The seed refuses a missing, weak (< 16 chars) or placeholder password.
- The admin is created with `must_change_password = true` and an
  **unverified email**.

**First admin login (O, in the browser):**

1. Log in at `https://cuencada.com/entrar` as `admin@cuencada.com`.
2. You are forced to change the password. Keep the new one in a password
   manager.
3. **Verify the email.** Logging in and changing the password do **not**
   send the verification email by themselves. Press **"Reenviar enlace"** on
   the verify banner, then click the link in the email. Chat and the gallery
   stay at 403 `EMAIL_UNVERIFIED` until then, so `admin@cuencada.com` must be
   a real, monitored mailbox.

### Email troubleshooting

If the verification email (or any other) doesn't arrive:

1. **Resend dashboard:**
   - **Emails:** is the message listed, and is it delivered, bounced or
     missing?
   - **Domains:** `cuencada.com` must show "Verified" (§ Resend DNS).
2. **API logs on `server_1`:**
   ```sh
   journalctl -u cuencada-server --since '1 hour ago' --no-pager | grep -E "mail\.|resend|job failed"
   ```
   - `mail.recipient_budget_exceeded`: the per-address budget skipped the
     send (at most one per purpose every 2 minutes, 3 an hour, 10 a day).
     The request still answers 202. Wait a few minutes, then press
     "Reenviar enlace" once.
   - `mail.cap_reached` / `mail.queue_full`: the global daily cap, or the
     mail queue is full (§ 10).
   - `job failed`: the send to Resend failed (API key, domain or a Resend
     outage).
   - Nothing at all: the request never reached the API, or the banner was
     still counting down.
3. **Receiving side:**
   - `admin@cuencada.com` receives mail through the registrar's inbound
     forwarding (Porkbun). Check that the forward exists and points at a
     mailbox someone reads.
   - Check that mailbox's spam folder: forwarded mail often lands there.

## 7. Smoke tests (O, A can read the output)

```sh
printf 'admin password: '; read -rs SMOKE_PASSWORD; echo; export SMOKE_PASSWORD
SMOKE_BASE_URL=https://cuencada.com SMOKE_EMAIL=admin@cuencada.com node scripts/deploy-smoke.mjs
unset SMOKE_PASSWORD
```

The smoke test checks:

- `/healthz`;
- the CSP and security headers on `/`, `sw.js` and a hashed asset;
- `no-cache` and `immutable` caching;
- the SPA fallback, and a 404 for a missing asset;
- the legacy redirect;
- login, `/api/me` (`no-store`) and `/api/cuencadas/2026`;
- a chat ticket plus a **WebSocket through nginx**.

It prints no secret. Then, by hand:

- **Upload:** a phone photo, and a > 40 MP desktop image (resize worker), on
  `/galeria/2026`. Each reaches "ready", and the display copy has no EXIF or
  GPS (`exiftool`).
- **CSP report:** DevTools → Console on `/`, `/galeria/2026` and `/chat`. The
  only expected entry is the zod `eval` probe (WP-2.3 L1). Anything else is a
  regression; run `node docs/security/csp-check.mjs` locally.
- **Email:** a password reset for a test account arrives from
  `no-reply@cuencada.com`, with `spf=pass`, `dkim=pass` and `dmarc=pass`.
- **Secrets:** the M1 check in § 4.
- **Logs:**
  - `sudo tail /var/log/nginx/cuencada-access.log` shows paths without query
    strings;
  - `journalctl -u cuencada-server` shows `ticket=[REDACTED]`;
  - log retention and permissions follow § 10.
- **TLS:**
  - `curl -sI http://cuencada.com` returns 301 to https;
  - `curl -sI https://www.cuencada.com` returns 301 to the apex;
  - the certificate's SAN covers both names, and the HSTS header is present.

## 8. Retire the legacy site

**How it's deployed today:** it isn't.

- `cuencada.com` resolves to `server_1`, but there is no cuencada vhost: nginx
  answers with `acleron.com`'s default site and certificate.
- `/cuencada2026.html` and `/mensajes.txt` return 404.
- There is no GitHub Pages site.

So the legacy files live only in **the repo and its history**.

1. **A** (done): nginx redirects the old URLs:
   - `/cuencada2026.html` → `/cuencada/2026`;
   - `/mensajes.txt`, `/mensajes.json` and `/images/fotos/*` → `/`.

   `/index.html` stays the SPA shell; see [nginx.md](nginx.md).
2. **A** (follow-up PR after the cutover is green): `git rm` the root
   `index.html`, `cuencada2026.html`, `images/`, `mensajes.json` and
   `canciones/`.
   - Keep `mensajes.txt` until the seed no longer reads it, or move it under
     `apps/server/`.
   - Update the Biome ignore list and AGENTS.md.
   - History stays (owner decision). The rotated links make the history
     copies harmless.
3. **O:** nothing to remove on the server.

## 9. PWA

- `mise run deploy-check` runs `check:sw`, so the service worker never caches
  private `/api/**`.
- nginx serves `sw.js`, `sw-purge.js`, `index.html` and the manifest with
  `no-cache`. Open tabs check for a new worker hourly and prompt
  "Actualizar".
- **Minimum client version** (backlog): until it exists, a security fix
  reaches PWA users only when they accept the prompt or reload (§ 11).

## 10. Observability and logs

**Where logs go:**

- **API:** Pino JSON goes to journald (`SyslogIdentifier=cuencada-server`).
  The host's Alloy or promtail ships journald to Loki with
  `unit="cuencada-server.service"`. Confirming that shipping is O's
  monitoring stack.
- **nginx:** `/var/log/nginx/cuencada-access.log` and `cuencada-error.log`
  (Security L3):
  - **Mode 0640, group `adm`.** Ubuntu's `/etc/logrotate.d/nginx` creates
    them as `www-data:adm 0640`. `root:adm 0640` is equally fine. Only root
    and `adm` members may read them. Check with
    `ls -l /var/log/nginx/cuencada-*`.
  - **Retention 14 days.** That is the Ubuntu default (`daily`,
    `rotate 14`, `compress`). Don't raise it: these logs hold IPs, user
    agents and paths.
  - **The access log** has no query strings (format `cuencada_redacted`).
  - **The error log can contain query strings.** On upstream failures nginx
    quotes the full request line, which can include `?ticket=` (single-use,
    30 s), `?q=` and `?search=`. That is why its level is `error`, why it has
    the same 0640 mode and 14-day retention, and why it must not be shipped
    anywhere wider than the access log.

**Alert rules (Grafana, LogQL):**

| Alert | Query | Condition |
|---|---|---|
| Daily email cap reached | `count_over_time({unit="cuencada-server.service"} \| json \| event="mail.cap_reached" [15m])` | > 0 |
| Mail queue full (emails dropped) | `count_over_time({unit="cuencada-server.service"} \| json \| event="mail.queue_full" [5m])` | > 0 |
| Admin/invite alert caps | `count_over_time({unit="cuencada-server.service"} \| json \| event=~"mail.(admin_alert\|invite_alert)_cap_reached" [1h])` | > 0 |
| Process restarts / crash loop | `count_over_time({unit="cuencada-server.service"} \|= "Main process exited" [10m])`, or `{syslog_identifier="systemd"} \|= "cuencada-server.service: Scheduled restart job"` | ≥ 1 warn, ≥ 3 page |
| OOM kill | `{syslog_identifier="kernel"} \|= "oom-kill" \|= "cuencada-server"` | > 0 |
| Fatal / failed start | `{unit="cuencada-server.service"} \| json \| level >= 50` | > 0 |
| Breached-password check unavailable (WP-2.3c: egress blocked or HIBP down, so the check is effectively off) | `count_over_time({unit="cuencada-server.service"} \| json \| event="password.breach_check_unavailable" [5m])` | > 0 for 15 min (three consecutive 5-min windows; the `unavailableTotal` counter keeps rising). One isolated warn is not actionable |
| Chat at capacity | `{unit="cuencada-server.service"} \|= "chat socket refused: at capacity"` | > 0 |
| 5xx rate (nginx) | `sum(count_over_time({filename="/var/log/nginx/cuencada-access.log"} \|~ "\" 5\\d\\d " [5m]))` | > 10 |

Pino levels are numeric: 50 = error, 60 = fatal.

## 11. Release checklist (every later deploy)

1. `main` is green in CI. `mise run verify` and `mise run deploy-check` pass.
2. Every new migration is **expand/contract**: migrations run before the new
   code, so the live code must work on the new schema.
3. New config key?
   - Map it in `infra/project.yml`: secrets under `server.credentials`,
     everything else under `server.env`. The preflight fails otherwise.
   - Add it to the vault when it's a secret.
4. Open the tunnel, `read -rs` the owner-role URL into
   `MIGRATE_DATABASE_URL` (`127.0.0.1`, § 4), then `mise run deploy`
   (O approves). Never `--skip-migrate` a release that has migrations.
5. Health and the secrets check (§ 4), then the smoke test (§ 7).
6. **Security fix?**
   - **Bump the minimum client version**, once that mechanism exists
     (backlog).
   - Until then, post an admin announcement so members reload.
   - Rotate any secret the fix concerns: `JWT_SECRET` logs everyone out;
     Resend and S3 keys are rotated in their dashboards, then the vault, then
     redeploy.
7. Record the release (commit, time, migrations) in the PR or the release
   notes.

---

## Resend DNS

Resend's dashboard is the source of truth for the exact values: Domains →
cuencada.com.

| Type | Name | Value | Notes |
|---|---|---|---|
| TXT | `resend._domainkey` | `p=<DKIM public key from the Resend dashboard>` | DKIM. Copy it exactly |
| MX | `send` | `feedback-smtp.<region>.amazonses.com` (priority 10) | Return path (bounces). The region is shown in the dashboard |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | SPF for the return-path subdomain |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:admin@cuencada.com; adkim=r; aspf=r` | Start with `p=none`. Move to `p=quarantine` after 2 clean weeks |

- `MAIL_FROM` is `Cuencada <no-reply@cuencada.com>`. The preflight checks it
  sends from the project domain.
- The root domain needs no SPF change for Resend. Never publish two SPF
  records on one name.
- **Receiving mail** at `admin@cuencada.com` needs the domain's own MX for a
  mailbox provider. That is separate from Resend's `send` MX.
- Restrict the API key to **sending only**, for the cuencada.com domain only.

## Bucket

**Two keys (Security L4):**

- **Runtime key:** a Linode *limited* access key with read/write on **this
  bucket only**. It goes to the vault (`vault_cuencada_s3_*`) and lives on
  the VPS as credentials.
- **Bucket-admin key:** a separate, **short-lived** key, used only on the
  operator's machine to create the bucket and set its ACL, CORS and
  lifecycle. Use a full-access key if Linode's limited keys can't change
  bucket configuration. **Delete it in the Linode console right after the
  last command below.** It never enters the vault or the VPS.

**Temporary s3cmd config:** mode 0600, deleted on exit, and the keys are
pasted with `read -rs`.

```sh
B=cuencada
umask 077; S3CFG="$(mktemp)"; trap 'rm -f "$S3CFG"' EXIT
printf 'bucket-admin access key: '; read -rs AK; echo
printf 'bucket-admin secret key: '; read -rs SK; echo
printf '[default]\naccess_key = %s\nsecret_key = %s\nhost_base = us-east-1.linodeobjects.com\nhost_bucket = %%(bucket)s.us-east-1.linodeobjects.com\nuse_https = True\n' \
  "$AK" "$SK" > "$S3CFG"
unset AK SK
S3="s3cmd -c $S3CFG"
$S3 mb s3://$B                                   # if not created in the Linode console
$S3 setacl s3://$B --acl-private                 # objects only via presigned URLs
$S3 setcors infra/bucket/cors.xml s3://$B        # PUT/GET/HEAD from https://cuencada.com, content-type only
$S3 setlifecycle infra/bucket/lifecycle.xml s3://$B   # abort incomplete multipart uploads after 1 day
$S3 info s3://$B; $S3 getlifecycle s3://$B
rm -f "$S3CFG"; trap - EXIT
# now delete the bucket-admin key in the Linode console
```

With the AWS CLI, the equivalent is
`aws --endpoint-url https://us-east-1.linodeobjects.com s3api put-bucket-cors --bucket "$B" --cors-configuration file://infra/bucket/cors.json`.
Use the same temporary-credential care: `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` come from `read -rs`, and you `unset` them afterwards.

The lifecycle has **no expiration rule**. Originals are written straight to
`cuencadas/<year>/originals/`, where accepted originals also live, so a
prefix expiry would delete real photos.

**Real-bucket check (O)**, with the **runtime** key, so it also proves that
key can upload and delete:

```sh
pnpm build
printf 'runtime access key: '; read -rs S3_ACCESS_KEY_ID; echo
printf 'runtime secret key: '; read -rs S3_SECRET_ACCESS_KEY; echo
export S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
S3_ENDPOINT=https://us-east-1.linodeobjects.com S3_REGION=us-east-1 S3_BUCKET=$B \
  node infra/bucket/check-presigned-put.mjs
unset S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
```

It writes one 1 KB object under `_preflight/`, deletes it, and expects:

- longer body → 403;
- other type → 403;
- control → 200;
- unsigned GET → 403;
- CORS from `https://cuencada.com` allowed, foreign origin refused.

## Runtime notes

- **Native modules:** the VPS installs argon2 0.44 (linux-x64 glibc
  prebuild) and sharp 0.35 (`@img/sharp-linux-x64`, glibc ≥ 2.26; Ubuntu
  24.04 has 2.39). Check after the first deploy:
  ```sh
  cd /srv/cuencada/current/apps/server && sudo -u svc_cuencada node -e "require('argon2'); require('sharp'); console.log('native modules ok')"
  ```
- **Threadpool:** `UV_THREADPOOL_SIZE=6` (in `server.env`).
  - argon2, sharp's async work and DNS/fs share libuv's pool.
  - WP-2.2 saw a caption save take about 13 s while images processed.
  - sharp is `concurrency(1)` with no cache, and avatars process at most 2 at
    a time.
- **Memory (2 GB host):** the drop-in sets `MemoryHigh=700M`/`MemoryMax=900M`.
  The video cap stays **150 MB** for now. After the resize it **may return to
  300 MB** with no migration (the DB CHECK still allows 300 MB):
  1. Change `MEDIA_SIZE_LIMITS.video` in `packages/types/src/media.ts` and
     its tests.
  2. Raise `MemoryMax` by about 300 MB.
  3. Watch the OOM alert.
