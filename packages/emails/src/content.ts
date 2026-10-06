/** Footer wordmark printed in every email. */
export const FOOTER_BRAND = "CUENCADA · Portal familiar";
/** Shown under the button, followed by the raw URL, for older mail clients. */
export const CTA_FALLBACK_LABEL =
  "¿El botón no funciona? Copia y pega este enlace en tu navegador:";
/** Footer reassurance line printed in every email. */
export const FOOTER_IGNORE = "Si no esperabas este correo, puedes ignorarlo.";

/** The single call to action of an email. */
export interface EmailCta {
  label: string;
  /** Already validated with `assertSafeUrl`. */
  url: string;
}

/**
 * Plain-string description of an email. The HTML (React) and the plain-text
 * renderers both consume this, so the two alternatives never drift apart.
 * Strings here are unescaped; React escapes them for HTML.
 */
export interface EmailContent {
  subject: string;
  /** Inbox preview line (hidden in the body). */
  preview: string;
  heading: string;
  greeting: string;
  paragraphs: readonly string[];
  cta: EmailCta | null;
  /** Small print after the button (expiry, single use…). */
  notes: readonly string[];
  /** Highlighted security warning, if any. */
  warning: string | null;
}

/**
 * Renders the plain-text alternative of an email. The CTA URL appears exactly once.
 */
export function renderPlainText(content: EmailContent): string {
  const blocks: string[] = [
    content.heading,
    content.greeting,
    ...content.paragraphs,
  ];
  if (content.cta !== null) {
    blocks.push(`${content.cta.label}:\n${content.cta.url}`);
  }
  blocks.push(...content.notes);
  if (content.warning !== null) {
    blocks.push(`IMPORTANTE: ${content.warning}`);
  }
  blocks.push(`--\n${FOOTER_BRAND}\n${FOOTER_IGNORE}`);
  return `${blocks.join("\n\n")}\n`;
}
