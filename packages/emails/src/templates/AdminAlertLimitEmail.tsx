import type { ReactElement } from "react";
import { EmailLayout } from "../components/EmailLayout.js";
import type { EmailContent } from "../content.js";
import {
  type EmailRenderOptions,
  type ResolvedEmailOptions,
  assertSafeUrl,
  cleanAlertName,
  endSentence,
  formatDateTime,
  resolveOptions,
} from "../format.js";

/** Props of the once-a-day "alert limit reached" notice to administrators. */
export interface AdminAlertLimitEmailProps {
  /** The administrator receiving the notice. */
  recipientName: string;
  /** When the limit was reached (`Date` or ISO string). */
  reachedAt: Date | string;
  /** Link to the audit log, e.g. `https://cuencada.com/admin/bitacora`. */
  auditLogUrl: string;
}

/**
 * Builds the copy of "Se alcanzó el límite de avisos de seguridad de hoy",
 * sent once per day when admin-account alerts reach their daily cap. It says
 * that removals of admin access are still always announced.
 *
 * @throws EmailRenderError on an unsafe URL or an invalid date.
 */
export function buildAdminAlertLimitContent(
  props: AdminAlertLimitEmailProps,
  options: ResolvedEmailOptions,
): EmailContent {
  const url = assertSafeUrl(
    props.auditLogUrl,
    "auditLogUrl",
    options.allowInsecureLinks,
  );
  const recipient = cleanAlertName(props.recipientName);
  const when = formatDateTime(props.reachedAt, "reachedAt", options);
  return {
    subject: "Se alcanzó el límite de avisos de seguridad de hoy",
    preview:
      "Hoy hubo muchos cambios en cuentas de administrador. Revisa la bitácora.",
    heading: "Se alcanzó el límite de avisos de seguridad de hoy",
    greeting: recipient === null ? "¡Hola!" : `¡Hola, ${recipient}!`,
    paragraphs: [
      {
        id: "reached",
        text: endSentence(
          `Hoy hubo muchos cambios en cuentas de administrador del portal de la Cuencada y el ${when} alcanzamos el límite diario de avisos por correo`,
        ),
      },
      {
        id: "still",
        text: "Hasta mañana solo te avisaremos cuando a alguien le quiten el rol de administrador, le desactiven la cuenta o le obliguen a restablecer la contraseña. Los demás cambios quedan en la bitácora.",
      },
    ],
    cta: { label: "Revisar la bitácora", url },
    notes: [],
    warning:
      "Si no reconoces esta actividad, habla de inmediato con los demás administradores.",
    // A security notice must never tell the reader to ignore it.
    footerNote:
      "Recibes este aviso de seguridad porque administras el portal de la Cuencada.",
  };
}

/** Admin-alert-limit email component (React Email). */
export function AdminAlertLimitEmail(
  props: AdminAlertLimitEmailProps & { options?: EmailRenderOptions },
): ReactElement {
  const resolved = resolveOptions(props.options);
  return (
    <EmailLayout
      content={buildAdminAlertLimitContent(props, resolved)}
      logoUrl={resolved.logoUrl}
    />
  );
}
