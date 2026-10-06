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

/** Largest use count the template accepts (the contract caps any invite at 50). */
const MAX_USES_LIMIT = 50;
/** Short invite references are hex (the first characters of the invite's UUID). */
const SHORT_ID = /^[0-9a-f]{4,12}$/i;

/** Props of the notice sent to every active admin when someone joins with an open invite link. */
export interface AdminInviteAcceptedEmailProps {
  /** The administrator receiving the notice. */
  recipientName: string;
  /** Display name the new member chose. Never their email address. */
  memberName: string;
  /** The invite's admin-only note, used as its label, if any. */
  inviteLabel?: string | null;
  /** Short invite reference: the first characters of its id (e.g. `3f2a9c1b`). */
  inviteShortId: string;
  /** Uses so far, this one included. */
  useCount: number;
  /** Uses allowed. */
  maxUses: number;
  /** When the account was created (`Date` or ISO string). */
  acceptedAt: Date | string;
  /** Where to review it, e.g. the bitácora filtered to the new member. */
  reviewUrl: string;
}

function assertUses(useCount: number, maxUses: number): void {
  const valid =
    Number.isInteger(useCount) &&
    Number.isInteger(maxUses) &&
    useCount >= 1 &&
    maxUses >= 1 &&
    maxUses <= MAX_USES_LIMIT &&
    useCount <= maxUses;
  if (!valid) {
    throw new EmailRenderError(
      EmailRenderErrorCode.InvalidOption,
      "useCount",
      "useCount and maxUses must be integers with 1 <= useCount <= maxUses <= 50.",
    );
  }
}

/**
 * Builds the copy of "Alguien se unió con un enlace de invitación", the
 * security notice for every acceptance of an open (not email-bound) invite
 * (WP-2.3b). Names only, like the other admin alerts: the new member's email
 * address is never included.
 *
 * @throws EmailRenderError on an unsafe URL, an invalid date, an invalid
 *   short id, or inconsistent use counts.
 */
export function buildAdminInviteAcceptedContent(
  props: AdminInviteAcceptedEmailProps,
  options: ResolvedEmailOptions,
): EmailContent {
  const url = assertSafeUrl(
    props.reviewUrl,
    "reviewUrl",
    options.allowInsecureLinks,
  );
  if (!SHORT_ID.test(props.inviteShortId)) {
    throw new EmailRenderError(
      EmailRenderErrorCode.InvalidOption,
      "inviteShortId",
      "inviteShortId must be 4 to 12 hex characters.",
    );
  }
  assertUses(props.useCount, props.maxUses);
  const recipient = cleanName(props.recipientName);
  const member = cleanName(props.memberName) ?? "Una persona";
  const label = cleanName(props.inviteLabel);
  const when = formatDateTime(props.acceptedAt, "acceptedAt", options);
  const shortId = props.inviteShortId.toLowerCase();
  const uses = `${props.useCount} de ${props.maxUses} ${props.maxUses === 1 ? "uso" : "usos"}`;
  const invite =
    label === null ? `el enlace ${shortId}` : `el enlace «${label}» (${shortId})`;
  return {
    subject: "Alguien se unió con un enlace de invitación",
    preview: `${member} creó su cuenta con un enlace abierto (${uses}).`,
    heading: "Alguien se unió con un enlace de invitación",
    greeting: recipient === null ? "¡Hola!" : `¡Hola, ${recipient}!`,
    paragraphs: [
      {
        id: "summary",
        text: endSentence(
          `${member} creó su cuenta en el portal de la Cuencada con ${invite} el ${when}`,
        ),
      },
      {
        id: "uses",
        text: `El enlace lleva ${uses}.`,
      },
      {
        id: "why",
        text: "Te avisamos porque cualquiera que reciba un enlace abierto puede usarlo. Si conoces a esta persona, no necesitas hacer nada.",
      },
    ],
    cta: { label: "Revisar en la bitácora", url },
    notes: [],
    warning:
      "Si no reconoces a esta persona, desactiva su cuenta y revoca el enlace desde el panel de administración.",
    // A security notice must never tell the reader to ignore it.
    footerNote:
      "Recibes este aviso de seguridad porque administras el portal de la Cuencada.",
  };
}

/** Admin-invite-accepted email component (React Email). */
export function AdminInviteAcceptedEmail(
  props: AdminInviteAcceptedEmailProps & { options?: EmailRenderOptions },
): ReactElement {
  const resolved = resolveOptions(props.options);
  return (
    <EmailLayout
      content={buildAdminInviteAcceptedContent(props, resolved)}
      logoUrl={resolved.logoUrl}
    />
  );
}
