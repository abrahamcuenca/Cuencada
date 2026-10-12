import type { ReactElement } from "react";
import { EmailLayout } from "../components/EmailLayout.js";
import type { EmailContent } from "../content.js";
import { EmailRenderError, EmailRenderErrorCode } from "../errors.js";
import {
  type EmailRenderOptions,
  type ResolvedEmailOptions,
  cleanName,
  endSentence,
  formatDateTime,
  resolveOptions,
} from "../format.js";

/**
 * Which two-step verification event the notice is about (WP-7). A fixed set:
 * the copy is chosen here, never by the caller.
 */
export const TwoFactorNotice = {
  /** The member turned two-step verification on. */
  Enabled: "enabled",
  /** The member turned it off. */
  Disabled: "disabled",
  /** An administrator reset it (lost phone and codes); every session was closed. */
  ResetByAdmin: "reset_by_admin",
  /** A recovery code was used to log in. */
  RecoveryCodeUsed: "recovery_code_used",
} as const;
export type TwoFactorNotice =
  (typeof TwoFactorNotice)[keyof typeof TwoFactorNotice];

/** Props of the two-step verification security notice. */
export interface TwoFactorNoticeEmailProps {
  displayName: string;
  notice: TwoFactorNotice;
  /** When it happened (`Date` or ISO string). */
  at: Date | string;
  /** Who to contact if it wasn't them. Printed as text, not a link. */
  supportContact: string;
  /** `recovery_code_used` only: unused codes left (0–10). */
  remainingCodes?: number;
}

interface NoticeCopy {
  subject: string;
  preview: string;
  heading: string;
  what: string;
  next: string;
}

function noticeCopy(props: TwoFactorNoticeEmailProps): NoticeCopy {
  switch (props.notice) {
    case TwoFactorNotice.Enabled:
      return {
        subject: "Activaste la verificación en dos pasos",
        preview: "Tu cuenta de la Cuencada ahora pide un código al entrar.",
        heading: "Activaste la verificación en dos pasos",
        what: "Activaste la verificación en dos pasos de tu cuenta en el portal de la Cuencada",
        next: "Desde ahora te pediremos un código de tu app de autenticación al entrar. Guarda tus códigos de recuperación en un lugar seguro.",
      };
    case TwoFactorNotice.Disabled:
      return {
        subject: "Desactivaste la verificación en dos pasos",
        preview: "Tu cuenta de la Cuencada ya no pide un código al entrar.",
        heading: "Desactivaste la verificación en dos pasos",
        what: "Desactivaste la verificación en dos pasos de tu cuenta en el portal de la Cuencada",
        next: "Ya no te pediremos un código al entrar. Puedes volver a activarla en Perfil → Sesiones y seguridad.",
      };
    case TwoFactorNotice.ResetByAdmin:
      return {
        subject: "Restablecieron tu verificación en dos pasos",
        preview: "Un administrador restableció la verificación en dos pasos de tu cuenta.",
        heading: "Restablecieron tu verificación en dos pasos",
        what: "Un administrador restableció la verificación en dos pasos de tu cuenta en el portal de la Cuencada y cerró todas tus sesiones",
        next: "Entra de nuevo con tu contraseña. Si eres administrador, te pediremos activarla otra vez al entrar.",
      };
    case TwoFactorNotice.RecoveryCodeUsed: {
      const left = props.remainingCodes;
      if (left !== undefined && (!Number.isInteger(left) || left < 0 || left > 10)) {
        throw new EmailRenderError(
          EmailRenderErrorCode.InvalidOption,
          "remainingCodes",
          "remainingCodes must be an integer between 0 and 10.",
        );
      }
      const remaining =
        left === undefined
          ? ""
          : left === 1
            ? " Te queda 1 código sin usar."
            : ` Te quedan ${left} códigos sin usar.`;
      return {
        subject: "Usaste un código de recuperación",
        preview: "Alguien entró a tu cuenta con un código de recuperación.",
        heading: "Usaste un código de recuperación",
        what: "Se usó uno de tus códigos de recuperación para entrar a tu cuenta en el portal de la Cuencada",
        next: `Cada código sirve una sola vez.${remaining} Si te quedan pocos, genera nuevos en Perfil → Sesiones y seguridad.`,
      };
    }
    default: {
      const unreachable: never = props.notice;
      void unreachable;
      throw new EmailRenderError(
        EmailRenderErrorCode.InvalidOption,
        "notice",
        "Unknown two-step verification notice.",
      );
    }
  }
}

/**
 * Builds the copy of a two-step verification notice. No button on purpose:
 * a security notice should not invite one-click actions.
 *
 * @throws EmailRenderError on an invalid date, notice or count.
 */
export function buildTwoFactorNoticeContent(
  props: TwoFactorNoticeEmailProps,
  options: ResolvedEmailOptions,
): EmailContent {
  const name = cleanName(props.displayName);
  const support =
    cleanName(props.supportContact) ?? "un administrador de la Cuencada";
  const at = formatDateTime(props.at, "at", options);
  const copy = noticeCopy(props);
  return {
    subject: copy.subject,
    preview: copy.preview,
    heading: copy.heading,
    greeting: name === null ? "¡Hola!" : `¡Hola, ${name}!`,
    paragraphs: [
      { id: "what", text: endSentence(`${copy.what} el ${at}`) },
      { id: "next", text: copy.next },
    ],
    cta: null,
    notes: [],
    warning: `Si no fuiste tú, escríbele de inmediato a ${support} para proteger tu cuenta.`,
    footerNote: `Si no reconoces este cambio, escríbenos a ${support} de inmediato.`,
  };
}

/** Two-step verification notice component (React Email). */
export function TwoFactorNoticeEmail(
  props: TwoFactorNoticeEmailProps & { options?: EmailRenderOptions },
): ReactElement {
  const resolved = resolveOptions(props.options);
  return (
    <EmailLayout
      content={buildTwoFactorNoticeContent(props, resolved)}
      logoUrl={resolved.logoUrl}
    />
  );
}
