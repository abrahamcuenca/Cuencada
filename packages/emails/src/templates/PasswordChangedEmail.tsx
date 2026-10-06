import type { ReactElement } from "react";
import { EmailLayout } from "../components/EmailLayout.js";
import type { EmailContent } from "../content.js";
import {
  type EmailRenderOptions,
  type ResolvedEmailOptions,
  cleanName,
  endSentence,
  formatDateTime,
  resolveOptions,
} from "../format.js";

/** Props of the "your password changed" security notice. */
export interface PasswordChangedEmailProps {
  displayName: string;
  /** When the password changed (`Date` or ISO string). */
  changedAt: Date | string;
  /** Who to contact if it wasn't them, e.g. `admin@cuencada.com`. Printed as text, not a link. */
  supportContact: string;
}

/**
 * Builds the copy of the password-changed notice. It has no button on purpose:
 * a security notice should not invite one-click actions.
 *
 * @throws EmailRenderError on an invalid date.
 */
export function buildPasswordChangedContent(
  props: PasswordChangedEmailProps,
  options: ResolvedEmailOptions,
): EmailContent {
  const name = cleanName(props.displayName);
  const support =
    cleanName(props.supportContact) ?? "un administrador de la Cuencada";
  const changed = formatDateTime(props.changedAt, "changedAt", options);
  return {
    subject: "Tu contraseña de la Cuencada cambió",
    preview: "Te avisamos por seguridad: la contraseña de tu cuenta cambió.",
    heading: "Tu contraseña cambió",
    greeting: name === null ? "¡Hola!" : `¡Hola, ${name}!`,
    paragraphs: [
      {
        id: "changed",
        text: endSentence(
          `Te avisamos que la contraseña de tu cuenta en el portal de la Cuencada se cambió el ${changed}`,
        ),
      },
      { id: "was-you", text: "Si fuiste tú, no tienes que hacer nada más." },
    ],
    cta: null,
    notes: [],
    warning: `Si no fuiste tú, escríbele de inmediato a ${support} para proteger tu cuenta.`,
    // A security notice must never tell the reader to ignore it.
    footerNote: `Si no reconoces este cambio, escríbenos a ${support} de inmediato.`,
  };
}

/** Password-changed email component (React Email). */
export function PasswordChangedEmail(
  props: PasswordChangedEmailProps & { options?: EmailRenderOptions },
): ReactElement {
  const resolved = resolveOptions(props.options);
  return (
    <EmailLayout
      content={buildPasswordChangedContent(props, resolved)}
      logoUrl={resolved.logoUrl}
    />
  );
}
