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
  /**
   * Which alerts reached their cap: admin-account changes (default) or
   * open-invite acceptances (WP-2.3b, own daily cap).
   */
  topic?: AdminAlertLimitTopic;
}

/** Which family of admin alerts reached its daily cap. */
export const AdminAlertLimitTopic = {
  AdminAccounts: "admin-accounts",
  OpenInvites: "open-invites",
} as const;
export type AdminAlertLimitTopic =
  (typeof AdminAlertLimitTopic)[keyof typeof AdminAlertLimitTopic];

const TOPIC_COPY: Record<
  AdminAlertLimitTopic,
  { preview: string; reached: string; still: string }
> = {
  "admin-accounts": {
    preview:
      "Hoy hubo muchos cambios en cuentas de administrador. Revisa la bitácora.",
    reached:
      "Hoy hubo muchos cambios en cuentas de administrador del portal de la Cuencada",
    still:
      "Hasta mañana solo te avisaremos cuando alguien se una como administrador, a alguien le quiten el rol de administrador, le desactiven la cuenta o le obliguen a restablecer la contraseña. Los demás cambios quedan en la bitácora.",
  },
  "open-invites": {
    preview:
      "Hoy muchas personas se unieron con enlaces abiertos. Revisa la bitácora.",
    reached:
      "Hoy muchas personas se unieron al portal de la Cuencada con enlaces de invitación abiertos",
    still:
      "Hasta mañana no te avisaremos de cada persona que se una con un enlace abierto. Todas quedan en la bitácora.",
  },
};

/**
 * Builds the copy of "Se alcanzó el límite de avisos de seguridad de hoy",
 * sent once per day when admin-account alerts (or, with `topic:
 * "open-invites"`, open-invite acceptance alerts) reach their daily cap. The
 * admin-account variant says that changes to who holds admin access are still
 * always announced.
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
  const copy = TOPIC_COPY[props.topic ?? AdminAlertLimitTopic.AdminAccounts];
  return {
    subject: "Se alcanzó el límite de avisos de seguridad de hoy",
    preview: copy.preview,
    heading: "Se alcanzó el límite de avisos de seguridad de hoy",
    greeting: recipient === null ? "¡Hola!" : `¡Hola, ${recipient}!`,
    paragraphs: [
      {
        id: "reached",
        text: endSentence(
          `${copy.reached} y el ${when} alcanzamos el límite diario de avisos por correo`,
        ),
      },
      {
        id: "still",
        text: copy.still,
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
