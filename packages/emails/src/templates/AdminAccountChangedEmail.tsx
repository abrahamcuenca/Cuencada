import type { ReactElement } from "react";
import { EmailLayout } from "../components/EmailLayout.js";
import type { EmailContent } from "../content.js";
import { EmailRenderError, EmailRenderErrorCode } from "../errors.js";
import {
  type EmailRenderOptions,
  type ResolvedEmailOptions,
  assertSafeUrl,
  cleanName,
  endSentence,
  formatDateTime,
  resolveOptions,
} from "../format.js";

/** What happened to an administrator account (fixed set; the copy is chosen here, never by the caller). */
export const AdminAccountChange = {
  /** A member became an administrator. */
  Promoted: "promoted",
  /** An administrator lost the administrator role. */
  Demoted: "demoted",
  /** The account was disabled. */
  Disabled: "disabled",
  /** The account was re-enabled. */
  Enabled: "enabled",
  /** The account must change its password on next use. */
  PasswordChangeRequired: "password_change_required",
  /** An administrator forced a password reset (sessions closed, reset link sent). */
  PasswordResetForced: "password_reset_forced",
} as const;
export type AdminAccountChange =
  (typeof AdminAccountChange)[keyof typeof AdminAccountChange];

const CHANGE_TEXT: Record<AdminAccountChange, string> = {
  promoted: "Le dio el rol de administrador.",
  demoted: "Le quitó el rol de administrador.",
  disabled: "Desactivó la cuenta.",
  enabled: "Volvió a activar la cuenta.",
  password_change_required:
    "Le pidió cambiar la contraseña en su próximo acceso.",
  password_reset_forced:
    "Forzó el restablecimiento de la contraseña y cerró todas sus sesiones.",
};

/** Props of the security notice sent to the other administrators. */
export interface AdminAccountChangedEmailProps {
  /** The administrator receiving the notice. */
  recipientName: string;
  /** The administrator who made the change. */
  actorName: string;
  /** The account that changed. */
  targetName: string;
  /** At least one change, in display order. */
  changes: readonly AdminAccountChange[];
  /** When it happened (`Date` or ISO string). */
  changedAt: Date | string;
  /** Link to the audit log, e.g. `https://cuencada.com/admin/bitacora`. */
  auditLogUrl: string;
}

/**
 * Builds the copy of the "Cambio en una cuenta de administrador" notice.
 * Names only: no email addresses, no secrets.
 *
 * @throws EmailRenderError on an unsafe URL, an invalid date, or no/unknown changes.
 */
export function buildAdminAccountChangedContent(
  props: AdminAccountChangedEmailProps,
  options: ResolvedEmailOptions,
): EmailContent {
  const url = assertSafeUrl(
    props.auditLogUrl,
    "auditLogUrl",
    options.allowInsecureLinks,
  );
  const changes = [...new Set(props.changes)];
  if (
    changes.length === 0 ||
    changes.some((change) => !Object.hasOwn(CHANGE_TEXT, change))
  ) {
    throw new EmailRenderError(
      EmailRenderErrorCode.InvalidOption,
      "changes",
      "changes must list at least one known change.",
    );
  }
  const recipient = cleanName(props.recipientName);
  const actor = cleanName(props.actorName) ?? "Un administrador";
  const target = cleanName(props.targetName) ?? "un administrador";
  const when = formatDateTime(props.changedAt, "changedAt", options);
  return {
    subject: "Cambio en una cuenta de administrador",
    preview: `${actor} cambió la cuenta de ${target} en el portal de la Cuencada.`,
    heading: "Cambio en una cuenta de administrador",
    greeting: recipient === null ? "¡Hola!" : `¡Hola, ${recipient}!`,
    paragraphs: [
      {
        id: "summary",
        text: endSentence(
          `${actor} hizo este cambio en la cuenta de ${target} el ${when}`,
        ),
      },
      ...changes.map((change) => ({
        id: `change-${change}`,
        text: CHANGE_TEXT[change],
      })),
      {
        id: "why",
        text: "Te avisamos porque eres administrador del portal de la Cuencada. Puedes revisar el detalle en la bitácora.",
      },
    ],
    cta: { label: "Revisar la bitácora", url },
    notes: [],
    warning:
      "Si no reconoces este cambio, habla de inmediato con los demás administradores.",
    // A security notice must never tell the reader to ignore it.
    footerNote:
      "Recibes este aviso de seguridad porque administras el portal de la Cuencada.",
  };
}

/** Admin-account-changed email component (React Email). */
export function AdminAccountChangedEmail(
  props: AdminAccountChangedEmailProps & { options?: EmailRenderOptions },
): ReactElement {
  const resolved = resolveOptions(props.options);
  return (
    <EmailLayout
      content={buildAdminAccountChangedContent(props, resolved)}
      logoUrl={resolved.logoUrl}
    />
  );
}
