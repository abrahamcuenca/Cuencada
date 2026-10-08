import { isInvitableCandidate } from "@cuencada/types";
import type { ReactNode } from "react";
import { useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { selectIsAdmin } from "../../auth/authSlice";
import { useGetInviteCandidateQuery } from "../api";

/** Props for {@link InvitePersonButton}. */
export interface InvitePersonButtonProps {
  /** The tree person shown on the page. */
  personId: string;
  className?: string | undefined;
}

/**
 * "Invitar" on a person page (WP-4.2): admins only, and only for a living
 * person without an account and without a pending invite. Opens the invite
 * form pre-filled (`/admin/invitaciones?persona=<id>`). Renders nothing
 * otherwise, including while the status loads or when it fails (the server
 * re-checks every rule on create anyway).
 */
export function InvitePersonButton({ personId, className }: InvitePersonButtonProps): ReactNode {
  const isAdmin = useAppSelector(selectIsAdmin);
  const candidate = useGetInviteCandidateQuery(personId, { skip: !isAdmin });
  const data = candidate.currentData;
  if (!isAdmin || data === undefined || !isInvitableCandidate(data)) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      icon="✉️"
      className={className}
      to={`/admin/invitaciones?persona=${encodeURIComponent(personId)}`}
      aria-label={`Invitar a ${data.fullName}`}
    >
      Invitar
    </Button>
  );
}
