import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { NGINX_SITE_TEMPLATE, type PreflightInput, runPreflight } from "./preflight.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");

const BUCKET = "fictional-media-bucket";
const PLATFORM_WITH_SUPPORT = "- name: Render the project's own site\n  when: project.nginx.site_template is defined\n";

type Dict = Record<string, unknown>;

/** The repository's real files, with the bucket placeholder filled in. */
function repoInput(overrides: { projectText?: string; nginxConf?: string; platform?: string | null } = {}): PreflightInput {
  const projectText = overrides.projectText ?? read("infra/project.yml").replaceAll("<bucket>", BUCKET);
  return {
    project: parseYaml(projectText),
    nginxConf: overrides.nginxConf ?? read(NGINX_SITE_TEMPLATE).replaceAll("<bucket>", BUCKET),
    cspDoc: read("docs/security/csp.md"),
    serverPackage: JSON.parse(read("apps/server/package.json")),
    platformNginxTasks: overrides.platform === undefined ? PLATFORM_WITH_SUPPORT : overrides.platform
  };
}

/** Run with one edit applied to the parsed project. */
function withProject(edit: (project: Dict, env: Dict) => void): ReturnType<typeof runPreflight> {
  const input = repoInput();
  const project = input.project as Dict;
  const env = (project.server as Dict).env as Dict;
  edit(project, env);
  return runPreflight(input);
}

/** Run with a text substitution in the nginx site (the substitution must apply). */
function withNginx(from: string | RegExp, to: string): ReturnType<typeof runPreflight> {
  const conf = read(NGINX_SITE_TEMPLATE).replaceAll("<bucket>", BUCKET);
  const edited = conf.replace(from, to);
  expect(edited).not.toBe(conf);
  return runPreflight(repoInput({ nginxConf: edited }));
}

describe("runPreflight", () => {
  it("passes on the repository's deploy files once the bucket name is filled in", () => {
    const result = runPreflight(repoInput());
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.vaultRefs).toEqual([
      "vault_cuencada_database_url",
      "vault_cuencada_jwt_secret",
      "vault_cuencada_resend_api_key",
      "vault_cuencada_s3_access_key_id",
      "vault_cuencada_s3_secret_access_key"
    ]);
  });

  it("fails while the <bucket> placeholder is still in project.yml and the nginx site", () => {
    const result = runPreflight(
      repoInput({ projectText: read("infra/project.yml"), nginxConf: read(NGINX_SITE_TEMPLATE) })
    );
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("S3_BUCKET"),
        expect.stringContaining("<bucket> placeholder")
      ])
    );
  });

  it("requires every secret to be a vault reference, never a literal or a filtered expression", () => {
    const literal = withProject((_project, env) => {
      env.JWT_SECRET = "a-literal-secret-that-is-long-enough-to-pass";
    });
    expect(literal.problems).toContain("server.env.JWT_SECRET must be a {{ vault_cuencada_* }} reference, never a literal");

    const filtered = withProject((_project, env) => {
      env.S3_SECRET_ACCESS_KEY = "{{ vault_cuencada_s3_secret_access_key | default('') }}";
    });
    expect(filtered.problems).toEqual(expect.arrayContaining([expect.stringContaining("no filters or defaults")]));
  });

  it("fails when a variable config.ts reads is not mapped, or a mapped one is unknown", () => {
    const unmapped = withProject((_project, env) => {
      Reflect.deleteProperty(env, "REFRESH_IDLE_DAYS");
    });
    expect(unmapped.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^server\.env\.REFRESH_IDLE_DAYS is not mapped/)]));

    const typo = withProject((_project, env) => {
      env.COOKIES_SECURE = "true";
    });
    expect(typo.problems).toContain("server.env.COOKIES_SECURE is not read by the server (typo?)");
  });

  it("keeps operator-only values off the VPS (owner-role URL, seed password and links)", () => {
    for (const key of ["MIGRATE_DATABASE_URL", "SEED_ADMIN_TEMP_PASSWORD", "SEED_WHATSAPP_URL"]) {
      const result = withProject((_project, env) => {
        env[key] = "{{ vault_cuencada_whatever }}";
      });
      expect(result.problems).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^server\\.env\\.${key} must not be on the VPS`))]));
    }
  });

  it("runs the mapped env through loadConfig with production rules", () => {
    const http = withProject((_project, env) => {
      env.APP_BASE_URL = "http://cuencada.com";
    });
    expect(http.problems).toEqual(expect.arrayContaining([expect.stringContaining("APP_BASE_URL: must be https:// in production")]));

    const notQuoted = withProject((_project, env) => {
      env.COOKIE_SECURE = true;
    });
    expect(notQuoted.problems).toEqual(expect.arrayContaining([expect.stringContaining("COOKIE_SECURE must be a quoted string")]));

    const trust = withProject((_project, env) => {
      env.TRUST_PROXY = "true";
    });
    expect(trust.problems).toContain("TRUST_PROXY must be loopback (nginx on the same host, no CDN)");
  });

  it("requires the upload origin in the client build to match the bucket the server presigns for", () => {
    const result = withProject((project) => {
      ((project.deploy as Dict).build_env as Dict).VITE_MEDIA_UPLOAD_ORIGIN = "https://us-southeast-1.linodeobjects.com";
    });
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.stringContaining(`VITE_MEDIA_UPLOAD_ORIGIN must be https://${BUCKET}.us-southeast-1.linodeobjects.com`)])
    );
  });

  it("refuses a migration or seed hidden in the build, and a migrate command other than the built migrator", () => {
    const result = withProject((project) => {
      (project.deploy as Dict).build_command = "pnpm turbo build && pnpm --filter @cuencada/server db:seed";
      (project.server as Dict).migrate_command = ["pnpm", "--filter", "@cuencada/server", "db:migrate:dev"];
    });
    expect(result.problems).toEqual(
      expect.arrayContaining([
        "deploy.build_command must not migrate or seed",
        "server.migrate_command must run the @cuencada/server db:migrate script"
      ])
    );
  });

  it("fails when any nginx CSP copy drifts from docs/security/csp.md", () => {
    const result = withNginx("frame-src https://weatherwidget.io;", "frame-src 'self' https://weatherwidget.io;");
    expect(result.problems).toContain(
      "nginx: a Content-Security-Policy differs from docs/security/csp.md (paste it verbatim, bucket filled in)"
    );
  });

  it("fails when a static location loses one of the documented security headers", () => {
    const result = withNginx(/\n\s*add_header X-Frame-Options "DENY" always;/, "");
    expect(result.problems).toContain("nginx: X-Frame-Options must accompany every CSP with the value from csp.md");
  });

  it("fails when X-Forwarded-For is appended or CF-Connecting-IP is passed through", () => {
    const appended = withNginx(
      /X-Forwarded-For {3}\$remote_addr;/,
      "X-Forwarded-For   $proxy_add_x_forwarded_for;"
    );
    expect(appended.problems).toEqual(
      expect.arrayContaining([
        "nginx: X-Forwarded-For must be overwritten with $remote_addr, never appended",
        "nginx: every proxied location must set X-Forwarded-For $remote_addr"
      ])
    );
    const cf = withNginx(/\n\s*proxy_set_header\s+CF-Connecting-IP\s+"";/, "");
    expect(cf.problems).toContain('nginx: every proxied location must drop CF-Connecting-IP ("")');
  });

  it("fails when the access log could record query strings", () => {
    const request = withNginx('"$request_method $cuencada_request_path $server_protocol"', '"$request"');
    expect(request.problems).toEqual(expect.arrayContaining([expect.stringContaining("must not log query strings")]));
    const combined = withNginx(
      /access_log \/var\/log\/nginx\/cuencada-access\.log cuencada_redacted;/,
      "access_log /var/log/nginx/cuencada-access.log;"
    );
    expect(combined.problems).toEqual(expect.arrayContaining([expect.stringContaining("must use the cuencada_redacted format")]));
  });

  it("requires the chat WebSocket upgrade with a read timeout above the 25 s ping", () => {
    const short = withNginx("proxy_read_timeout    75s;", "proxy_read_timeout    20s;");
    expect(short.problems).toContain("nginx: the chat socket proxy_read_timeout must exceed the 25 s ping");
    const missing = withNginx("location = /api/chat/ws {", "location = /api/chat/socket {");
    expect(missing.problems).toContain("nginx: location = /api/chat/ws (chat WebSocket upgrade) is missing");
  });

  it("blocks when the Acleron platform would ignore the project's nginx site, and warns when it can't tell", () => {
    const stock = runPreflight(repoInput({ platform: "- name: Render HTTPS Nginx config (TLS enabled)\n" }));
    expect(stock.problems).toEqual(expect.arrayContaining([expect.stringContaining("ignores nginx.site_template")]));
    const manual = runPreflight({ ...repoInput({ platform: "- name: Render HTTPS Nginx config\n" }), manualNginx: true });
    expect(manual.problems).toEqual([]);
    expect(manual.warnings).toEqual([expect.stringContaining("CUENCADA_NGINX_MANUAL=1")]);
    const unknown = runPreflight(repoInput({ platform: null }));
    expect(unknown.problems).toEqual([]);
    expect(unknown.warnings).toEqual([expect.stringContaining("platform checkout not found")]);
  });
});
