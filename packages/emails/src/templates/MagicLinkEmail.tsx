import type { ReactElement } from "react";
import { EmailLayout } from "../components/EmailLayout.js";
import type { EmailContent } from "../content.js";
import {
  type EmailRenderOptions,
  type ResolvedEmailOptions,
  assertSafeUrl,
  cleanName,
  formatDuration,
  resolveOptions,
} from "../format.js";

/** Props of the passwordless sign-in email. */
export interface MagicLinkEmailProps {
  displayName: string;
  /** `https://cuencada.com/entrar/enlace#t=<token>` (token in the fragment). */
  loginUrl: string;
  /** Link TTL in minutes (integer, 1–43 200). */
  expiresInMinutes: number;
}

/**
 * Builds the copy of the magic-link email.
 *
 * @throws EmailRenderError on an unsafe URL or invalid TTL.
 */
export function buildMagicLinkContent(
  props: MagicLinkEmailProps,
  options: ResolvedEmailOptions,
): EmailContent {
  const url = assertSafeUrl(
    props.loginUrl,
    "loginUrl",
    options.allowInsecureLinks,
  );
  const name = cleanName(props.displayName);
  const ttl = formatDuration(props.expiresInMinutes, "expiresInMinutes");
  return {
    subject: "Tu enlace para entrar a la Cuencada",
    preview: `Entra al portal de la Cuencada sin contraseña. El enlace vence en ${ttl}.`,
    heading: "Tu enlace para entrar",
    greeting: name === null ? "¡Hola!" : `¡Hola, ${name}!`,
    paragraphs: [
      "Pediste entrar al portal de la Cuencada sin contraseña. Toca el botón para iniciar sesión.",
    ],
    cta: { label: "Entrar a la Cuencada", url },
    notes: [
      `El enlace funciona una sola vez y vence en ${ttl}.`,
      "Si no lo pediste tú, no tienes que hacer nada: tu cuenta sigue segura.",
    ],
    warning: null,
  };
}

/** Magic-link email component (React Email). */
export function MagicLinkEmail(
  props: MagicLinkEmailProps & { options?: EmailRenderOptions },
): ReactElement {
  const resolved = resolveOptions(props.options);
  return (
    <EmailLayout
      content={buildMagicLinkContent(props, resolved)}
      logoUrl={resolved.logoUrl}
    />
  );
}
