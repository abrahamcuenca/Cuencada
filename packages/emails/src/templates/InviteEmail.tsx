import type { ReactElement } from "react";
import { EmailLayout } from "../components/EmailLayout.js";
import type { EmailContent } from "../content.js";
import {
  type EmailRenderOptions,
  type ResolvedEmailOptions,
  assertSafeUrl,
  cleanName,
  endSentence,
  formatDateTime,
  resolveOptions,
} from "../format.js";

/** Props of the invitation email. Never pass the inviter's email address. */
export interface InviteEmailProps {
  /** Display name of the admin or relative who sent the invite. */
  inviterName: string;
  /** Name the admin typed for the invitee, if any. */
  inviteeName?: string | null;
  /** `https://cuencada.com/invitacion#t=<token>` (token in the fragment). */
  acceptUrl: string;
  /** When the invite expires (`Date` or ISO string). */
  expiresAt: Date | string;
}

/**
 * Builds the copy of the invitation email.
 *
 * @throws EmailRenderError on an unsafe URL or invalid date.
 */
export function buildInviteContent(
  props: InviteEmailProps,
  options: ResolvedEmailOptions,
): EmailContent {
  const url = assertSafeUrl(
    props.acceptUrl,
    "acceptUrl",
    options.allowInsecureLinks,
  );
  const inviter = cleanName(props.inviterName) ?? "Alguien de la familia";
  const invitee = cleanName(props.inviteeName);
  const expires = formatDateTime(props.expiresAt, "expiresAt", options);
  return {
    subject: `${inviter} te invitó al portal de la Cuencada`,
    preview: `${inviter} te invitó al portal familiar de la Cuencada.`,
    heading: "¡Te esperamos en la Cuencada!",
    greeting: invitee === null ? "¡Hola!" : `¡Hola, ${invitee}!`,
    paragraphs: [
      `${inviter} te invitó a unirte al portal familiar de la Cuencada, donde compartimos fotos, confirmamos asistencia y nos mantenemos en contacto toda la familia.`,
      "Crea tu cuenta con el botón de abajo; solo toma un par de minutos.",
    ],
    cta: { label: "Aceptar invitación", url },
    notes: [
      endSentence(`Esta invitación vence el ${expires}`),
      "La invitación es personal, por favor no la reenvíes.",
    ],
    warning: null,
  };
}

/** Invitation email component (React Email). */
export function InviteEmail(
  props: InviteEmailProps & { options?: EmailRenderOptions },
): ReactElement {
  const resolved = resolveOptions(props.options);
  return (
    <EmailLayout
      content={buildInviteContent(props, resolved)}
      logoUrl={resolved.logoUrl}
    />
  );
}
