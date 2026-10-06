/**
 * Mobile quality-gate probes run inside the page: horizontal overflow, touch
 * target sizes (sampled) and form-control font sizes.
 */
import type { BrowserContext, Page } from "@playwright/test";

/** One element that failed a probe. */
export interface GateFinding {
  /** Short description: tag, role/name, text. */
  element: string;
  detail: string;
}

/** Result of the overflow probe. */
export interface OverflowResult {
  scrollWidth: number;
  clientWidth: number;
  /** `window.innerWidth`: above `clientWidth` when the browser zoomed out to fit wider content. */
  innerWidth: number;
  culprits: GateFinding[];
  /** Fixed elements (and their children) that pass the viewport, reported apart from in-flow culprits. */
  fixedCulprits: GateFinding[];
  /** The worst overflow seen while the page loaded (see {@link recordTransientOverflow}), or null. */
  transient: {
    scrollWidth: number;
    clientWidth: number;
    atMs: number;
    culprits: GateFinding[];
    fixedCulprits: GateFinding[];
    /** Viewport and load state at that moment. */
    state: string;
  } | null;
}

/**
 * In-page finder for `position: fixed` elements (or their descendants) that
 * pass the viewport. They are not counted as the cause of document overflow
 * but are listed, so an overflowing fixed bar can never hide.
 */
function findFixedCulprits(): { element: string; detail: string }[] {
  const clientWidth = document.documentElement.clientWidth;
  const fixedRoot = (element: Element): Element | null => {
    for (let node: Element | null = element; node !== null && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).position === "fixed") return node;
    }
    return null;
  };
  const found: { element: string; detail: string }[] = [];
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    if (found.length >= 8) break;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || (rect.right <= clientWidth + 0.5 && rect.left >= -0.5)) continue;
    const root = fixedRoot(element);
    if (root === null) continue;
    const cls = typeof element.className === "string" && element.className !== "" ? `.${element.className.split(" ")[0]}` : "";
    const rootCls = typeof root.className === "string" && root.className !== "" ? `.${root.className.split(" ")[0]}` : "";
    const style = getComputedStyle(element);
    const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
    found.push({
      element: `${element.tagName.toLowerCase()}${cls}`,
      detail: `left=${rect.left.toFixed(1)}px right=${rect.right.toFixed(1)}px width=${rect.width.toFixed(1)}px minWidth=${style.minWidth} in=${root.tagName.toLowerCase()}${rootCls} text="${text}"`
    });
  }
  return found;
}

/**
 * In-page culprit finder (serialised into the page, so self-contained).
 * Lists in-flow elements whose right edge passes the viewport. Skipped:
 * `position: fixed` elements and their descendants (they follow the
 * viewport, so they are a symptom of a wider layout viewport, never the
 * cause) and content clipped by a horizontal scroller that itself fits.
 * Sticky elements are kept: they stay in flow and can widen the page.
 */
function findOverflowCulprits(): { element: string; detail: string }[] {
  const clientWidth = document.documentElement.clientWidth;
  const inFixed = (element: Element): boolean => {
    for (let node: Element | null = element; node !== null && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).position === "fixed") return true;
    }
    return false;
  };
  const clippedByScroller = (element: Element): boolean => {
    for (let parent = element.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== "visible" && parent.getBoundingClientRect().right <= clientWidth + 0.5) return true;
    }
    return false;
  };
  const culprits: { element: string; detail: string }[] = [];
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    if (culprits.length >= 8) break;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.right <= clientWidth + 0.5 || inFixed(element) || clippedByScroller(element)) continue;
    const cls = typeof element.className === "string" && element.className !== "" ? `.${element.className.split(" ")[0]}` : "";
    const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
    culprits.push({
      element: `${element.tagName.toLowerCase()}${cls}`,
      detail: `right=${rect.right.toFixed(1)}px width=${rect.width.toFixed(1)}px position=${getComputedStyle(element).position} text="${text}"`
    });
  }
  return culprits;
}

/**
 * Record, from the first frame of every page in `context`, the worst
 * horizontal overflow and its culprits at that moment. A transient overflow
 * matters on its own: mobile Chrome zooms out to fit the widest content and
 * stays zoomed out, which is how a CI run ended with a 322 px layout
 * viewport on a 320 px phone.
 */
export async function recordTransientOverflow(context: BrowserContext): Promise<void> {
  await context.addInitScript(`(() => {
    const find = ${findOverflowCulprits.toString()};
    const findFixed = ${findFixedCulprits.toString()};
    const start = performance.now();
    window.__e2eOverflow = null;
    const tick = () => {
      const root = document.documentElement;
      if (root && document.body && (root.scrollWidth > root.clientWidth || window.innerWidth > root.clientWidth)) {
        const worst = window.__e2eOverflow;
        if (worst === null || root.scrollWidth > worst.scrollWidth) {
          const vv = window.visualViewport;
          window.__e2eOverflow = {
            scrollWidth: root.scrollWidth,
            clientWidth: root.clientWidth,
            atMs: Math.round(performance.now() - start),
            culprits: find(),
            fixedCulprits: findFixed(),
            state: "innerWidth=" + window.innerWidth + " vv=" + (vv ? vv.width.toFixed(1) + "@" + vv.scale.toFixed(4) : "none") +
              " readyState=" + document.readyState + " sheets=" + document.styleSheets.length + " fonts=" + document.fonts.status
          };
        }
      }
      if (performance.now() - start < 15000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();`);
}

/** Overflow: the document must not scroll sideways, now or at any point while it loaded. */
export async function horizontalOverflow(page: Page): Promise<OverflowResult> {
  const now = await page.evaluate(`(() => {
    const find = ${findOverflowCulprits.toString()};
    const findFixed = ${findFixedCulprits.toString()};
    const root = document.documentElement;
    const over = root.scrollWidth > root.clientWidth || window.innerWidth > root.clientWidth;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      innerWidth: window.innerWidth,
      culprits: over ? find() : [],
      fixedCulprits: findFixed(),
      transient: window.__e2eOverflow ?? null
    };
  })()`);
  return now as OverflowResult; // shape built by the expression above
}

/** Minimum touch target (plan: 44×44 px). */
export const MIN_TARGET_PX = 44;

/**
 * Sample every visible interactive element and report the ones smaller than
 * {@link MIN_TARGET_PX} in either dimension. Exempt, as in WCAG 2.5.8:
 * links inline in a sentence, visually hidden native inputs whose visible
 * label is the target (the label is measured instead), and the skip link
 * while off-screen.
 */
export async function smallTouchTargets(page: Page): Promise<{ sampled: number; findings: GateFinding[] }> {
  return page.evaluate((min) => {
    const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"], [role="tab"], [tabindex="0"]';
    const findings: { element: string; detail: string }[] = [];
    let sampled = 0;
    const describe = (element: Element): string => {
      const name = element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? "";
      return `${element.tagName.toLowerCase()}${element.getAttribute("role") ? `[role=${element.getAttribute("role")}]` : ""} "${name}"`;
    };
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || element.closest("[inert], [aria-hidden='true']")) continue;
      let rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      // Skip link: off-screen until focused.
      if (rect.bottom < 0 || rect.right < 0) continue;
      // Inline links in running text are exempt.
      if (element.tagName === "A" && style.display === "inline" && element.parentElement !== null && ["P", "LI", "SPAN", "SMALL"].includes(element.parentElement.tagName) && (element.parentElement.textContent?.trim().length ?? 0) > (element.textContent?.trim().length ?? 0) + 3) continue;
      const label = element.closest("label") ?? (element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null);
      // Visually hidden native control: its <label> is the target.
      if (rect.width <= 2 || rect.height <= 2) {
        if (label === null) continue;
        rect = label.getBoundingClientRect();
      }
      const tooSmall = (box: DOMRect): boolean => box.width + 0.5 < min || box.height + 0.5 < min;
      // The label's hit area: the design system stretches it over the whole row with an
      // absolutely positioned `::after` (inset 0), i.e. the label's containing block.
      const labelArea = (node: Element): DOMRect => {
        const after = getComputedStyle(node, "::after");
        const parent = node instanceof HTMLElement ? node.offsetParent : null;
        if (after.content !== "none" && after.position === "absolute" && parent !== null) return parent.getBoundingClientRect();
        return node.getBoundingClientRect();
      };
      sampled += 1;
      // A small checkbox/switch passes when its label (which toggles it too) is a full-size target (WCAG 2.5.8 "equivalent").
      if (tooSmall(rect) && label !== null && !tooSmall(labelArea(label))) continue;
      if (tooSmall(rect)) {
        findings.push({ element: describe(element), detail: `${Math.round(rect.width)}×${Math.round(rect.height)}` });
      }
    }
    return { sampled, findings };
  }, MIN_TARGET_PX);
}

/** Form controls whose font size is below 16 px (iOS zooms on focus). */
export async function smallInputFonts(page: Page): Promise<GateFinding[]> {
  return page.evaluate(() => {
    const findings: { element: string; detail: string }[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), select, textarea'))) {
      const style = getComputedStyle(element);
      if (style.display === "none") continue;
      const size = Number.parseFloat(style.fontSize);
      if (size < 16) {
        findings.push({
          element: `${element.tagName.toLowerCase()}[name=${element.getAttribute("name") ?? element.id}]`,
          detail: `${size}px`
        });
      }
    }
    return findings;
  });
}
