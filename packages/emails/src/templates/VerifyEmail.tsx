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

/** Props of the email-verification email. */
export interface VerifyEmailProps {
  displayName: string;
  /** Verification link with the token in the fragment. */
  verifyUrl: string;
  /** Link TTL in minutes (integer, 1–43 200). */
  expiresInMinutes: number;
}

/**
 * Builds the copy of the email-verification email.
 *
 * @throws EmailRenderError on an unsafe URL or invalid TTL.
 */
export function buildVerifyContent(
  props: VerifyEmailProps,
  options: ResolvedEmailOptions,
): EmailContent {
  const url = assertSafeUrl(
    props.verifyUrl,
    "verifyUrl",
    options.allowInsecureLinks,
  );
  const name = cleanName(props.displayName);
  const ttl = formatDuration(props.expiresInMinutes, "expiresInMinutes");
  return {
    subject: "Confirma tu correo para la Cuencada",
    preview:
      "Confirma que este correo es tuyo para terminar de configurar tu cuenta.",
    heading: "Confirma tu correo",
    greeting: name === null ? "¡Hola!" : `¡Hola, ${name}!`,
    paragraphs: [
      "Para terminar de configurar tu cuenta en el portal de la Cuencada, confirma que este correo es tuyo.",
    ],
    cta: { label: "Confirmar mi correo", url },
    notes: [`El enlace funciona una sola vez y vence en ${ttl}.`],
    warning: null,
  };
}

/** Email-verification component (React Email). */
export function VerifyEmail(
  props: VerifyEmailProps & { options?: EmailRenderOptions },
): ReactElement {
  const resolved = resolveOptions(props.options);
  return (
    <EmailLayout
      content={buildVerifyContent(props, resolved)}
      logoUrl={resolved.logoUrl}
    />
  );
}
