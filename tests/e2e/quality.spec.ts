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
import { type GateFinding, horizontalOverflow, type OverflowResult, recordTransientOverflow, smallInputFonts, smallTouchTargets } from "./support/gates.js";

const WIDTHS = [320, 375] as const;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface RouteCheck {
  name: string;
  /** Path, or a function that navigates there (for routes with generated ids). */
  open: string | ((page: Page) => Promise<void>);
  /** Heading that proves the page rendered its content (not an error state) before measuring. */
  ready?: string;
}

const PUBLIC_ROUTES: RouteCheck[] = [
  { name: "home", open: "/" },
  { name: `year-${FUTURE_YEAR}`, open: `/cuencada/${FUTURE_YEAR}`, ready: `Programa Cuencada ${FUTURE_YEAR}` },
  { name: `year-${SEEDED_YEAR}`, open: `/cuencada/${SEEDED_YEAR}`, ready: `Programa Cuencada ${SEEDED_YEAR}` },
  { name: "entrar", open: "/entrar" },
  { name: "recuperar", open: "/recuperar" },
  { name: "invitacion-sin-token", open: "/invitacion" }
];

const MEMBER_ROUTES: RouteCheck[] = [
  { name: "home-member", open: "/" },
  { name: `year-${FUTURE_YEAR}-member`, open: `/cuencada/${FUTURE_YEAR}`, ready: `Programa Cuencada ${FUTURE_YEAR}` },
  { name: "galeria", open: `/galeria/${FUTURE_YEAR}`, ready: `Álbum vivo ${FUTURE_YEAR}` },
  { name: "directorio", open: "/directorio", ready: "Directorio familiar" },
  { name: "arbol", open: "/arbol", ready: "Árbol familiar" },
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
  overflow: OverflowResult;
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
  if (route.ready !== undefined) await expect(page.getByRole("heading", { name: route.ready })).toBeVisible();
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
  // Font fingerprint (widths of reference strings in the page's body font): compare a CI run
  // with a local one to rule fonts in or out when only one of them overflows.
  const fontProbe = await page.evaluate(() => {
    const span = document.createElement("span");
    span.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font:600 16px var(--font-body, sans-serif)";
    document.body.append(span);
    const widths: Record<string, number> = {};
    for (const text of ["Directorio familiar", "Filtros", "⚙️🔎💬📅", "Pueblo Ejemplo · Norte"]) {
      span.textContent = text;
      widths[text] = Number(span.getBoundingClientRect().width.toFixed(3));
    }
    span.remove();
    return widths;
  });
  const body = JSON.stringify({ fontProbe, results }, null, 2);
  writeFileSync(testInfo.outputPath("quality-gates.json"), body);
  await testInfo.attach("quality-gates.json", { body, contentType: "application/json" });
  return results;
}

function assertGates(results: RouteResult[]): void {
  for (const result of results) {
    const where = `${result.route} @ ${result.width}px`;
    const { overflow } = result;
    expect.soft(overflow.scrollWidth, `${where}: horizontal overflow ${JSON.stringify(overflow.culprits)}`).toBeLessThanOrEqual(overflow.clientWidth);
    expect.soft(overflow.innerWidth, `${where}: layout viewport wider than the screen (zoomed out) ${JSON.stringify(overflow.culprits)}`).toBeLessThanOrEqual(
      overflow.clientWidth
    );
    expect.soft(overflow.transient, `${where}: horizontal overflow while the page loaded`).toBeNull();
    expect.soft(overflow.fixedCulprits, `${where}: fixed elements wider than the screen`).toEqual([]);
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
    expect(overflow.culprits.map((culprit) => culprit.element)).toContain("div");
    const targets = await smallTouchTargets(page);
    expect(targets.findings.map((finding) => finding.element)).toEqual(['button "x"', 'input ""']);
    expect(await smallInputFonts(page)).toEqual([{ element: "input[name=small]", detail: "14px" }]);
  });

  test("the overflow probe names in-flow culprits, skips fixed bars, and records transient overflow", async ({ page }) => {
    await recordTransientOverflow(page.context());
    await page.setViewportSize({ width: 320, height: 640 });
    // A fixed bar that is 2 px too wide plus an in-flow block that is too wide only for the first 300 ms.
    await page.goto(
      `data:text/html,${encodeURIComponent(`<meta name="viewport" content="width=device-width, initial-scale=1">
      <body style="margin:0"><main><div id="late" class="transient" style="width:400px">ancho al cargar</div></main>
      <nav class="bar" style="position:fixed;bottom:0;left:0;width:322px;height:40px"><a href="#x">Inicio</a></nav>
      <script>setTimeout(() => { document.getElementById("late").style.width = "100px"; }, 300);</script></body>`)}`
    );
    await page.waitForTimeout(800);
    const overflow = await horizontalOverflow(page);
    expect(overflow.culprits.some((culprit) => culprit.element.startsWith("nav") || culprit.element === "a")).toBe(false);
    expect(overflow.fixedCulprits.map((culprit) => culprit.element)).toContain("nav.bar");
    expect(overflow.transient?.culprits.map((culprit) => culprit.element)).toContain("div.transient");
  });

  test("public routes", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await recordTransientOverflow(page.context());
    assertGates(await checkRoutes(page, testInfo, PUBLIC_ROUTES));
  });

  test("member routes", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await recordTransientOverflow(page.context());
    await login(page, castMember(ProjectKey.Iphone, CastRole.Fede));
    assertGates(await checkRoutes(page, testInfo, MEMBER_ROUTES));
  });

  test("the bottom nav with a 99+ chat badge fits at 320 px", async ({ page }, testInfo) => {
    await recordTransientOverflow(page.context());
    await login(page, castMember(ProjectKey.Iphone, CastRole.Fede));
    // Force the largest unread badge on the Chat tab (the server caps unread counts at 999).
    await page.route("**/api/chat/rooms", async (route) => {
      const response = await route.fetch();
      const rooms: unknown = await response.json();
      const patched = Array.isArray(rooms)
        ? rooms.map((room: unknown) => (typeof room === "object" && room !== null ? { ...room, unreadCount: 999 } : room))
        : rooms;
      await route.fulfill({ response, json: patched });
    });
    const results = await checkRoutes(page, testInfo, [
      { name: "directorio-badge", open: "/directorio", ready: "Directorio familiar" },
      { name: "mas-badge", open: "/mas" }
    ]);
    await expect(page.getByRole("navigation", { name: "Navegación inferior" }).getByRole("link", { name: /Chat.*sin leer/ })).toBeVisible();
    assertGates(results);
  });

  test("admin routes", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await recordTransientOverflow(page.context());
    await login(page, castMember(ProjectKey.Iphone, CastRole.Admin));
    assertGates(await checkRoutes(page, testInfo, ADMIN_ROUTES));
  });
});
