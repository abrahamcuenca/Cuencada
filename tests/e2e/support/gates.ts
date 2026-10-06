/**
 * Mobile quality-gate probes run inside the page: horizontal overflow, touch
 * target sizes (sampled) and form-control font sizes.
 */
import type { Page } from "@playwright/test";

/** One element that failed a probe. */
export interface GateFinding {
  /** Short description: tag, role/name, text. */
  element: string;
  detail: string;
}

/** Overflow: the document must not scroll sideways. */
export async function horizontalOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number; culprits: GateFinding[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const culprits: { element: string; detail: string }[] = [];
    if (root.scrollWidth > clientWidth) {
      // Content inside a horizontal scroller (overflow-x other than visible) that itself fits is not a culprit.
      const clippedByScroller = (element: HTMLElement): boolean => {
        for (let parent = element.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowX !== "visible" && parent.getBoundingClientRect().right <= clientWidth + 1) return true;
        }
        return false;
      };
      for (const element of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.right > clientWidth + 1 && culprits.length < 5 && !clippedByScroller(element)) {
          culprits.push({
            element: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ")[0]}` : ""}`,
            detail: `right=${Math.round(rect.right)}px`
          });
        }
      }
    }
    return { scrollWidth: root.scrollWidth, clientWidth, culprits };
  });
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
