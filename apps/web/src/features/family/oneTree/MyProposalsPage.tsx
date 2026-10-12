import type { TreeLinkProposal } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { formatDate } from "../../../shared/lib/dates";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useToast } from "../../../shared/ui/Toast";
import { cx } from "../../../shared/ui/cx";
import { useAccessDenial } from "../../auth/accessDenied";
import { AccessDeniedState } from "../../auth/components/AccessDeniedState";
import { PORTAL_TIME_ZONE } from "../../auth/sessionDisplay";
import { useGetMyProposalsQuery, useWithdrawProposalMutation } from "./api";
import { PROPOSAL_STATUS_LABELS, PROPOSAL_STATUS_TONES, describeProposal } from "./labels";
import styles from "./oneTree.module.css";

const PAGE_SIZE = 20;

/**
 * `/arbol/propuestas` ("Mis propuestas", WP-6.4): the caller's own
 * tree-link proposals, newest first, with their status, the admin's note
 * (only the proposer sees it) and "Retirar" while pending.
 */
export function MyProposalsPage(): ReactNode {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  return (
    <div className={cx("cu-container", styles.page)}>
      <Link to="/arbol">‹ Árbol familiar</Link>
      <h1 className={styles.pageTitle}>Mis propuestas</h1>
      <p className={styles.muted}>
        Lo que propusiste para unir el árbol («Es la misma persona», «Conectar con…»). Un administrador revisa cada propuesta antes de cambiar algo.
      </p>
      <ul className={styles.list}>
        {cursors.map((cursor, index) => (
          <ProposalsPage key={cursor ?? "first"} cursor={cursor} isLast={index === cursors.length - 1} onMore={(next) => setCursors([...cursors, next])} />
        ))}
      </ul>
    </div>
  );
}

function ProposalsPage({ cursor, isLast, onMore }: { cursor: string | null; isLast: boolean; onMore: (cursor: string) => void }): ReactNode {
  const page = useGetMyProposalsQuery({ limit: PAGE_SIZE, ...(cursor === null ? {} : { cursor }) });
  const denial = useAccessDenial(page.error);
  if (page.currentData === undefined) {
    if (denial !== null) {
      return (
        <li>
          <AccessDeniedState denial={denial} verifyTitle="Verifica tu correo para proponer cambios al árbol" forbiddenTitle="No tienes acceso al árbol familiar" />
        </li>
      );
    }
    if (page.isError) {
      return (
        <li>
          <EmptyState icon="⚠️" title="No pudimos cargar tus propuestas" action={<Button onClick={() => void page.refetch()}>Reintentar</Button>} />
        </li>
      );
    }
    return (
      <li>
        <Skeleton shape="block" height="6rem" />
      </li>
    );
  }
  const { items, nextCursor } = page.currentData;
  if (items.length === 0 && cursor === null) {
    return (
      <li>
        <EmptyState
          icon="🌳"
          title="Aún no has propuesto nada"
          description="En la ficha de cualquier persona del árbol usa «Es la misma persona…» o «Conectar con…»."
          action={<Button to="/arbol">Ir al árbol</Button>}
        />
      </li>
    );
  }
  return (
    <>
      {items.map((proposal) => (
        <li key={proposal.id}>
          <ProposalItem proposal={proposal} />
        </li>
      ))}
      {isLast && nextCursor !== null ? (
        <li>
          <Button variant="secondary" fullWidth onClick={() => onMore(nextCursor)}>
            Cargar más
          </Button>
        </li>
      ) : null}
    </>
  );
}

function ProposalItem({ proposal }: { proposal: TreeLinkProposal }): ReactNode {
  const [withdraw, state] = useWithdrawProposalMutation();
  const toast = useToast();
  const doWithdraw = async (): Promise<void> => {
    try {
      await withdraw(proposal.id).unwrap();
      toast.show({ message: "Retiraste la propuesta.", tone: "success" });
    } catch (error) {
      if (!isAbortError(error)) toast.show({ message: getApiErrorMessage(error), tone: "danger" });
    }
  };
  return (
    <article className={styles.item} aria-label={describeProposal(proposal)}>
      <div className={styles.itemHeader}>
        <h2 className={styles.itemTitle}>{describeProposal(proposal)}</h2>
        <Badge tone={PROPOSAL_STATUS_TONES[proposal.status]}>{PROPOSAL_STATUS_LABELS[proposal.status]}</Badge>
      </div>
      <p className={styles.muted}>Enviada el {formatDate(proposal.createdAt, PORTAL_TIME_ZONE)}</p>
      {proposal.note !== null ? <p className={styles.note}>{proposal.note}</p> : null}
      {proposal.resolutionNote !== null ? (
        <p className={styles.note}>
          <strong>Nota del administrador:</strong> {proposal.resolutionNote}
        </p>
      ) : null}
      {proposal.status === "pending" ? (
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" loading={state.isLoading} onClick={() => void doWithdraw()}>
            Retirar
          </Button>
        </div>
      ) : null}
    </article>
  );
}
