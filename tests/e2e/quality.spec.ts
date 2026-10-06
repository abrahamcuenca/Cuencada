/**
 * Mobile quality gates on the main routes (WP-2.2 + plan "Mobile-first
 * requirement"):
 * - at 320 and 375 px: no horizontal overflow, sampled touch targets ≥ 44 px,
 *   form controls ≥ 16 px font;
 * - axe-core (WCAG 2.0/2.1/2.2 A + AA rules) at 375 px: zero serious or
 *   critical violations.
 *
 * Runs in the `mobile-gates` project (iPhone 13 profile, viewport resized
 * per check). Results are attached as `quality-gates.json`.
 */
import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { CastRole, castMember, FUTURE_YEAR, ProjectKey, SEEDED_YEAR } from "./harness/people.js";
import { expect, login, test } from "./support/fixtures.js";
import { type GateFinding, horizontalOverflow, smallInputFonts, smallTouchTargets } from "./support/gates.js";

const WIDTHS = [320, 375] as const;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface RouteCheck {
  name: string;
  /** Path, or a function that navigates there (for routes with generated ids). */
  open: string | ((page: Page) => Promise<void>);
}

const PUBLIC_ROUTES: RouteCheck[] = [
  { name: "home", open: "/" },
  { name: `year-${FUTURE_YEAR}`, open: `/cuencada/${FUTURE_YEAR}` },
  { name: `year-${SEEDED_YEAR}`, open: `/cuencada/${SEEDED_YEAR}` },
  { name: "entrar", open: "/entrar" },
  { name: "recuperar", open: "/recuperar" },
  { name: "invitacion-sin-token", open: "/invitacion" }
];

const MEMBER_ROUTES: RouteCheck[] = [
  { name: "home-member", open: "/" },
  { name: `year-${FUTURE_YEAR}-member`, open: `/cuencada/${FUTURE_YEAR}` },
  { name: "galeria", open: `/galeria/${FUTURE_YEAR}` },
  { name: "directorio", open: "/directorio" },
  { name: "arbol", open: "/arbol" },
  { name: "chat", open: "/chat" },
  {
    name: "chat-sala",
    open: async (page) => {
      await page.goto("/chat");
      await page.getByRole("list", { name: "Salas" }).getByRole("link").first().click();
      await expect(page.getByRole("textbox", { name: "Mensaje" })).toBeVisible();
    }
  },
  { name: "perfil", open: "/perfil" },
  { name: "sesiones", open: "/perfil/sesiones" },
  { name: "mas", open: "/mas" }
];

const ADMIN_ROUTES: RouteCheck[] = [
  { name: "admin", open: "/admin" },
  { name: "admin-invitaciones", open: "/admin/invitaciones" },
  { name: "admin-usuarios", open: "/admin/usuarios" },
  { name: "admin-familia", open: "/admin/familia" },
  { name: "admin-cuencadas", open: "/admin/cuencadas" }
];

/** Per-route results, attached to the report. */
interface RouteResult {
  route: string;
  width: number;
  overflow: { scrollWidth: number; clientWidth: number; culprits: GateFinding[] };
  targets: { sampled: number; findings: GateFinding[] };
  inputFonts: GateFinding[];
  axe?: { id: string; impact: string | null | undefined; nodes: number; help: string }[];
}

async function open(page: Page, route: RouteCheck): Promise<void> {
  if (typeof route.open === "string") await page.goto(route.open);
  else await route.open(page);
  await page.waitForLoadState("networkidle");
  // Let lazy routes, skeletons and fonts settle.
  await expect(page.locator("main")).toBeVisible();
  await page.waitForTimeout(400);
}

async function checkRoutes(page: Page, testInfo: TestInfo, routes: RouteCheck[]): Promise<RouteResult[]> {
  const results: RouteResult[] = [];
  for (const route of routes) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 740 });
      await open(page, route);
      const result: RouteResult = {
        route: route.name,
        width,
        overflow: await horizontalOverflow(page),
        targets: await smallTouchTargets(page),
        inputFonts: await smallInputFonts(page)
      };
      if (width === 375) {
        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        result.axe = axe.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.length,
          help: violation.help
        }));
      }
      results.push(result);
    }
  }
  const body = JSON.stringify(results, null, 2);
  writeFileSync(testInfo.outputPath("quality-gates.json"), body);
  await testInfo.attach("quality-gates.json", { body, contentType: "application/json" });
  return results;
}

function assertGates(results: RouteResult[]): void {
  for (const result of results) {
    const where = `${result.route} @ ${result.width}px`;
    expect.soft(result.overflow.scrollWidth, `${where}: horizontal overflow ${JSON.stringify(result.overflow.culprits)}`).toBeLessThanOrEqual(
      result.overflow.clientWidth
    );
    expect.soft(result.inputFonts, `${where}: form controls under 16px`).toEqual([]);
    expect.soft(result.targets.findings, `${where}: touch targets under 44px (${result.targets.sampled} sampled)`).toEqual([]);
    const serious = (result.axe ?? []).filter((violation) => violation.impact === "serious" || violation.impact === "critical");
    expect.soft(serious, `${where}: axe serious/critical violations`).toEqual([]);
  }
}

test.describe("mobile quality gates", () => {
  test("the probes catch overflow, small targets and small input fonts", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.setContent(`
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <main>
        <div style="width: 400px">too wide</div>
        <button style="width: 20px; height: 20px; padding: 0">x</button>
        <p>Texto con <a href="#a">enlace en línea</a> exento.</p>
        <input name="small" style="font-size: 14px">
      </main>`);
    const overflow = await horizontalOverflow(page);
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
    const targets = await smallTouchTargets(page);
    expect(targets.findings.map((finding) => finding.element)).toEqual(['button "x"', 'input ""']);
    expect(await smallInputFonts(page)).toEqual([{ element: "input[name=small]", detail: "14px" }]);
  });

  test("public routes", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    assertGates(await checkRoutes(page, testInfo, PUBLIC_ROUTES));
  });

  test("member routes", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await login(page, castMember(ProjectKey.Iphone, CastRole.Fede));
    assertGates(await checkRoutes(page, testInfo, MEMBER_ROUTES));
  });

  test("admin routes", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await login(page, castMember(ProjectKey.Iphone, CastRole.Admin));
    assertGates(await checkRoutes(page, testInfo, ADMIN_ROUTES));
  });
});
