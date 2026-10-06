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

/** Props of the password-reset email. */
export interface PasswordResetEmailProps {
  displayName: string;
  /** `https://cuencada.com/restablecer#t=<token>` (token in the fragment). */
  resetUrl: string;
  /** Link TTL in minutes (integer, 1–43 200). */
  expiresInMinutes: number;
}

/**
 * Builds the copy of the password-reset email.
 *
 * @throws EmailRenderError on an unsafe URL or invalid TTL.
 */
export function buildPasswordResetContent(
  props: PasswordResetEmailProps,
  options: ResolvedEmailOptions,
): EmailContent {
  const url = assertSafeUrl(
    props.resetUrl,
    "resetUrl",
    options.allowInsecureLinks,
  );
  const name = cleanName(props.displayName);
  const ttl = formatDuration(props.expiresInMinutes, "expiresInMinutes");
  return {
    subject: "Restablece tu contraseña de la Cuencada",
    preview: `Crea una contraseña nueva para tu cuenta. El enlace vence en ${ttl}.`,
    heading: "Restablece tu contraseña",
    greeting: name === null ? "¡Hola!" : `¡Hola, ${name}!`,
    paragraphs: [
      "Recibimos una solicitud para cambiar la contraseña de tu cuenta en el portal de la Cuencada. Toca el botón para crear una nueva.",
    ],
    cta: { label: "Crear contraseña nueva", url },
    notes: [
      `El enlace funciona una sola vez y vence en ${ttl}. Al cambiarla, cerraremos tu sesión en todos tus dispositivos.`,
      "Si no lo pediste tú, ignora este correo: tu contraseña actual no cambia.",
    ],
    warning: null,
  };
}

/** Password-reset email component (React Email). */
export function PasswordResetEmail(
  props: PasswordResetEmailProps & { options?: EmailRenderOptions },
): ReactElement {
  const resolved = resolveOptions(props.options);
  return (
    <EmailLayout
      content={buildPasswordResetContent(props, resolved)}
      logoUrl={resolved.logoUrl}
    />
  );
}
