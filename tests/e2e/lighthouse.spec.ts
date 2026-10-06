/**
 * Lighthouse mobile (default mobile emulation + simulated slow 4G) on Home,
 * a year page and Fotos, against the e2e stack. Opt-in with
 * `E2E_LIGHTHOUSE=1` (slow; needs its own Chromium with a debugging port).
 * Target ≥ 90 for performance, accessibility and best practices.
 *
 * `E2E_UPDATE_DOCS=1` also writes the summary to
 * `docs/ux/lighthouse/wp-2.2-summary.json`.
 *
 * Caveat: `vite preview` serves without gzip/brotli (nginx compresses in
 * production), so performance here is a lower bound.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import lighthouse from "lighthouse";
import { CastRole, castMember, FUTURE_YEAR, ProjectKey } from "./harness/people.js";
import { E2E_BROWSER_ENV, REPO_ROOT, WEB_ORIGIN } from "./harness/settings.js";
import { login } from "./support/fixtures.js";

const DEBUG_PORT = Number(process.env.E2E_LIGHTHOUSE_PORT ?? 9339);
const TARGET = 90;
const CATEGORIES = ["performance", "accessibility", "best-practices"] as const;

const PAGES = [
  { name: "home", path: "/", member: false },
  { name: `cuencada-${FUTURE_YEAR}`, path: `/cuencada/${FUTURE_YEAR}`, member: false },
  { name: `galeria-${FUTURE_YEAR}`, path: `/galeria/${FUTURE_YEAR}`, member: true }
] as const;

interface PageScores {
  page: string;
  path: string;
  /** False when storage (and the SW cache) was kept, i.e. a warm load. */
  cold: boolean;
  scores: Record<(typeof CATEGORIES)[number], number>;
  metrics: { lcpMs: number | null; tbtMs: number | null; cls: number | null; fcpMs: number | null };
  failedAudits: string[];
}

test.describe("lighthouse mobile", () => {
  test.skip(process.env.E2E_LIGHTHOUSE !== "1", "set E2E_LIGHTHOUSE=1 to run Lighthouse");

  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture names from the destructuring pattern.
  test("Home, a year page and Fotos score ≥ 90 for performance, accessibility and best practices", async ({}, testInfo) => {
    test.setTimeout(300_000);
    const profile = mkdtempSync(join(tmpdir(), "cuencada-e2e-lh-"));
    const context = await chromium.launchPersistentContext(profile, {
      args: [`--remote-debugging-port=${DEBUG_PORT}`, "--ignore-certificate-errors"],
      env: E2E_BROWSER_ENV,
      ignoreHTTPSErrors: true,
      baseURL: WEB_ORIGIN,
      extraHTTPHeaders: { "x-forwarded-for": "10.200.0.9" }
    });
    const results: PageScores[] = [];
    try {
      for (const target of PAGES) {
        if (target.member) {
          // Lighthouse opens its own tab in this (persistent) profile, so the refresh cookie set here is used.
          const page = await context.newPage();
          await login(page, castMember(ProjectKey.Desktop, CastRole.Fede));
          await page.close();
        }
        const runner = await lighthouse(`${WEB_ORIGIN}${target.path}`, {
          port: DEBUG_PORT,
          output: "json",
          logLevel: "error",
          onlyCategories: [...CATEGORIES],
          // Public pages load cold (storage + SW cache cleared). The member page keeps
          // storage so the login cookie survives, so it runs warm (SW precache) — noted in the summary.
          disableStorageReset: target.member
        });
        if (runner === undefined) throw new Error("lighthouse returned no result");
        const { lhr } = runner;
        if (lhr.runtimeError !== undefined) throw new Error(`lighthouse ${target.name}: ${lhr.runtimeError.code}`);
        const score = (id: (typeof CATEGORIES)[number]): number => Math.round((lhr.categories[id]?.score ?? 0) * 100);
        const metric = (id: string): number | null => lhr.audits[id]?.numericValue ?? null;
        results.push({
          page: target.name,
          path: target.path,
          cold: !target.member,
          scores: { performance: score("performance"), accessibility: score("accessibility"), "best-practices": score("best-practices") },
          metrics: {
            lcpMs: metric("largest-contentful-paint"),
            tbtMs: metric("total-blocking-time"),
            cls: metric("cumulative-layout-shift"),
            fcpMs: metric("first-contentful-paint")
          },
          failedAudits: Object.values(lhr.audits)
            .filter((audit) => audit.score !== null && audit.score < 0.9 && audit.scoreDisplayMode !== "informative" && audit.scoreDisplayMode !== "notApplicable")
            .map((audit) => audit.id)
        });
      }
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }

    const summary = JSON.stringify(
      { generatedAt: new Date().toISOString(), lighthouse: "13.x", formFactor: "mobile", throttling: "simulated (Lighthouse default)", target: TARGET, results },
      null,
      2
    );
    writeFileSync(testInfo.outputPath("lighthouse-summary.json"), summary);
    await testInfo.attach("lighthouse-summary.json", { body: summary, contentType: "application/json" });
    if (process.env.E2E_UPDATE_DOCS === "1") {
      const dir = join(REPO_ROOT, "docs/ux/lighthouse");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "wp-2.2-summary.json"), `${summary}\n`);
    }
    for (const result of results) {
      for (const category of CATEGORIES) {
        expect.soft(result.scores[category], `${result.page} ${category}`).toBeGreaterThanOrEqual(TARGET);
      }
    }
  });
});
