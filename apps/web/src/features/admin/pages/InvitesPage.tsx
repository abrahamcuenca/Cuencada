import { type AdminInviteCreated, type AdminInviteListItem, idSchema, type InviteStatus, inviteStatusSchema } from "@cuencada/types";
import { type ReactNode, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { Select } from "../../../shared/ui/Select";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useToast } from "../../../shared/ui/Toast";
import styles from "../admin.module.css";
import {
  type InviteListFilter,
  useGetInviteCandidateQuery,
  useListAdminInvitesInfiniteQuery,
  useResendAdminInviteMutation,
  useRevokeAdminInviteMutation
} from "../api";
import { ConfirmDialog, ListFooter, Notice } from "../components/common";
import { InviteForm } from "../components/InviteForm";
import { InviteLinkBox } from "../components/InviteLinkBox";
import { formatInstant } from "../lib/format";
import { candidateBlockedReason, type InviteFormPerson } from "../lib/inviteForm";
import { INVITE_STATUS, ROLE_LABEL } from "../lib/labels";

const STATUS_OPTIONS = [
  { value: "", label: "Todas" },
  ...inviteStatusSchema.options.map((status) => ({ value: status, label: INVITE_STATUS[status].label }))
];

/** Query parameter that opens the form pre-filled for a tree person (`InvitePersonButton`). */
export const INVITE_PERSON_PARAM = "persona";

/**
 * `/admin/invitaciones`: create, list, revoke and resend invites.
 * `?persona=<id>` opens the form for an email invite linked to that person.
 */
export function InvitesPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const parsedStatus = inviteStatusSchema.safeParse(params.get("estado"));
  const status: InviteStatus | null = parsedStatus.success ? parsedStatus.data : null;
  const filter = useMemo<InviteListFilter>(() => (status === null ? {} : { status }), [status]);
  const parsedPerson = idSchema.safeParse(params.get(INVITE_PERSON_PARAM));
  const personaId = parsedPerson.success ? parsedPerson.data : null;
  const [creatingManually, setCreating] = useState(false);
  const creating = creatingManually || personaId !== null;
  // The one-time URL lives only in this state; "Listo" or leaving the page drops it.
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const toast = useToast();
  const statusId = useId();

  /** Close the form and drop `?persona=` so a reload does not reopen it. */
  const closeForm = (): void => {
    setCreating(false);
    if (personaId === null) return;
    const next = new URLSearchParams(params);
    next.delete(INVITE_PERSON_PARAM);
    setParams(next, { replace: true });
  };

  const onCreated = (created: AdminInviteCreated): void => {
    closeForm();
    if (created.inviteUrl !== null) {
      setInviteUrl(created.inviteUrl);
      return;
    }
    toast.show({ message: `Enviamos la invitación a ${created.invite.email ?? "su correo"}.`, tone: "success" });
  };

  return (
    <>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Invitaciones</h1>
        {creating || inviteUrl !== null ? null : (
          <Button icon="＋" onClick={() => setCreating(true)}>
            Invitar
          </Button>
        )}
      </div>

      {inviteUrl === null ? null : <InviteLinkBox url={inviteUrl} onDone={() => setInviteUrl(null)} />}

      {creating ? (
        <section aria-labelledby="nueva-invitacion" className={styles.panel}>
          <h2 id="nueva-invitacion" className={styles.sectionTitle}>
            Nueva invitación
          </h2>
          <Card>
            {personaId === null ? (
              <InviteForm onCreated={onCreated} onCancel={closeForm} />
            ) : (
              <PersonInviteForm personId={personaId} onCreated={onCreated} onCancel={closeForm} />
            )}
          </Card>
        </section>
      ) : null}

      <section aria-label="Lista de invitaciones" className={styles.panel}>
        <div className={styles.filters}>
          <label htmlFor={statusId} className={styles.navLabel}>
            Estado
          </label>
          <Select
            id={statusId}
            value={status ?? ""}
            options={STATUS_OPTIONS}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value === "") next.delete("estado");
              else next.set("estado", event.target.value);
              setParams(next, { replace: true });
            }}
          />
        </div>
        <InviteList filter={filter} />
      </section>
    </>
  );
}

interface PersonInviteFormProps {
  personId: string;
  onCreated: (created: AdminInviteCreated) => void;
  onCancel: () => void;
}

/** The form pre-filled with a tree person, once their invite status is known. */
function PersonInviteForm({ personId, onCreated, onCancel }: PersonInviteFormProps): ReactNode {
  const candidate = useGetInviteCandidateQuery(personId);
  if (candidate.currentData === undefined && !candidate.isError) return <Skeleton shape="block" height="12rem" />;
  const data = candidate.currentData;
  const blocked = data === undefined ? null : candidateBlockedReason(data);
  const initialPerson: InviteFormPerson | null = data !== undefined && blocked === null ? { id: data.id, fullName: data.fullName } : null;
  let message: string | null = null;
  if (data === undefined) message = "No encontramos a esa persona en el árbol.";
  else if (blocked !== null) message = `No se puede vincular a ${data.fullName}: ${blocked.toLowerCase()}.`;
  return (
    <>
      <Notice tone="info" message={message} />
      <InviteForm key={personId} initialPerson={initialPerson} onCreated={onCreated} onCancel={onCancel} />
    </>
  );
}

function InviteList({ filter }: { filter: InviteListFilter }): ReactNode {
  const list = useListAdminInvitesInfiniteQuery(filter);
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const [revoking, setRevoking] = useState<AdminInviteListItem | null>(null);
  const [revoke, revokeState] = useRevokeAdminInviteMutation();
  const [resend] = useResendAdminInviteMutation();
  const [resendingId, setResendingId] = useState<string | null>(null);
  const toast = useToast();

  const confirmRevoke = async (): Promise<void> => {
    if (revoking === null) return;
    try {
      await revoke(revoking.id).unwrap();
      toast.show({ message: "Invitación revocada. El enlace ya no funciona.", tone: "success" });
      setRevoking(null);
    } catch (error) {
      if (isAbortError(error)) return;
      setRevoking(null);
      toast.show({ message: getApiErrorMessage(error), tone: "danger" });
    }
  };

  const doResend = async (invite: AdminInviteListItem): Promise<void> => {
    setResendingId(invite.id);
    try {
      await resend(invite.id).unwrap();
      toast.show({ message: `Reenviamos la invitación a ${invite.email ?? "su correo"}. El enlace anterior ya no funciona.`, tone: "success" });
    } catch (error) {
      if (!isAbortError(error)) toast.show({ message: getApiErrorMessage(error), tone: "danger" });
    } finally {
      setResendingId(null);
    }
  };

  return (
    <>
      <ul className={styles.rows}>
        {items.map((invite) => (
          <li key={invite.id}>
            <InviteCard
              invite={invite}
              resending={resendingId === invite.id}
              onResend={() => void doResend(invite)}
              onRevoke={() => setRevoking(invite)}
            />
          </li>
        ))}
      </ul>
      <ListFooter
        isLoading={list.isLoading}
        isError={list.isError}
        isEmpty={items.length === 0}
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        emptyTitle="No hay invitaciones"
        emptyDescription="Crea una con «Invitar»."
        errorTitle="No pudimos cargar las invitaciones"
        onRetry={() => void list.refetch()}
        onMore={() => void list.fetchNextPage()}
      />
      <ConfirmDialog
        open={revoking !== null}
        title="¿Revocar la invitación?"
        description={
          revoking?.email === null
            ? "El enlace dejará de funcionar para quienes todavía no lo usan. Las cuentas ya creadas no cambian."
            : `La invitación para ${revoking?.email ?? ""} dejará de funcionar.`
        }
        confirmLabel="Revocar"
        busy={revokeState.isLoading}
        onConfirm={() => void confirmRevoke()}
        onClose={() => setRevoking(null)}
      />
    </>
  );
}

interface InviteCardProps {
  invite: AdminInviteListItem;
  resending: boolean;
  onResend: () => void;
  onRevoke: () => void;
}

function InviteCard({ invite, resending, onResend, onRevoke }: InviteCardProps): ReactNode {
  const status = INVITE_STATUS[invite.status];
  const pending = invite.status === "pending";
  const titleId = useId();
  return (
    <Card as="article" padding="sm" className={styles.item} aria-labelledby={titleId}>
      <div className={styles.itemHead}>
        <h2 id={titleId} className={styles.itemTitle}>{invite.email ?? "Enlace abierto"}</h2>
        <div className={styles.badges}>
          <Badge tone={status.tone}>{status.label}</Badge>
          {invite.role === "admin" ? <Badge tone="festive">{ROLE_LABEL.admin}</Badge> : null}
        </div>
      </div>
      {invite.person === undefined || invite.person === null ? null : (
        <p className={styles.invitePerson}>Para: {invite.person.fullName}</p>
      )}
      <p className={styles.muted}>
        {pending ? "Vence" : "Vencía"} el {formatInstant(invite.expiresAt)} · Usos: {invite.useCount} de {invite.maxUses}
      </p>
      <p className={styles.muted}>
        {invite.lastSentAt === null ? "Sin envío por correo (enlace)" : `Enviada por correo: ${formatInstant(invite.lastSentAt)}`}
        {invite.createdByName === null ? "" : ` · Creada por ${invite.createdByName}`}
      </p>
      {invite.note === null ? null : <p className={styles.muted}>Nota: {invite.note}</p>}
      {pending ? (
        <div className={styles.actions}>
          {invite.email === null ? null : (
            <Button size="sm" variant="secondary" loading={resending} onClick={onResend}>
              Reenviar
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onRevoke}>
            Revocar
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
