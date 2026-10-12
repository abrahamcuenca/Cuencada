import type { PersonSummary, TreeLinkProposal, TreeLinkProposalGroup } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { formatDate } from "../../../../shared/lib/dates";
import { AvatarCircle } from "../../../../shared/ui/AvatarCircle";
import { Badge } from "../../../../shared/ui/Badge";
import { Button } from "../../../../shared/ui/Button";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { Tabs } from "../../../../shared/ui/Tabs";
import { cx } from "../../../../shared/ui/cx";
import { useAccessDenial } from "../../../auth/accessDenied";
import { AccessDeniedState } from "../../../auth/components/AccessDeniedState";
import { PORTAL_TIME_ZONE } from "../../../auth/sessionDisplay";
import { ADMIN_VERIFY_TITLE } from "../../admin/pages/AdminFamilyPage";
import adminStyles from "../../admin/admin.module.css";
import { displayName } from "../../lib/tree";
import { useGetProposalGroupsQuery } from "../api";
import { DELETED_PERSON, PROPOSAL_STATUS_LABELS, PROPOSAL_STATUS_TONES, describeProposal } from "../labels";
import styles from "../oneTree.module.css";
import { type ResolveDecision, ResolveDialog } from "./ResolveDialog";

const PAGE_SIZE = 20;
const ALL_TAB = "todas";

/** The proposal being resolved, with how many same ones follow it. */
interface Resolving {
  proposal: TreeLinkProposal;
  decision: ResolveDecision;
  sameCount: number;
}

/**
 * `/admin/familia/propuestas` ("Propuestas del árbol", WP-6.4): members'
 * "Es la misma persona" and "Conectar con…" proposals, grouped by pair,
 * pending first. Each pair shows both people side by side; "Aprobar…" runs
 * the merge (with its preview) or creates the relationship, "Rechazar…"
 * takes a note for the proposer.
 */
export function TreeProposalsPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const tab = params.get("vista") === ALL_TAB ? ALL_TAB : "pendientes";
  const [resolving, setResolving] = useState<Resolving | null>(null);

  return (
    <div className={cx("cu-container", adminStyles.page)}>
      <Link to="/admin" className={adminStyles.back}>
        ‹ Panel
      </Link>
      <div className={adminStyles.pageHeader}>
        <h1 className={adminStyles.pageTitle}>Propuestas del árbol</h1>
      </div>
      <p className={styles.muted}>
        Familiares que encontraron a la misma persona dos veces, o a parientes sin conectar. Nada cambia en el árbol hasta que apruebes.
      </p>
      <Tabs
        label="Estado de las propuestas"
        variant="underline"
        value={tab}
        onChange={(id) => setParams(id === ALL_TAB ? { vista: ALL_TAB } : {}, { replace: true })}
        items={[
          { id: "pendientes", label: "Pendientes", content: <GroupList key="pending" pendingOnly onResolve={setResolving} /> },
          { id: ALL_TAB, label: "Todas", content: <GroupList key="all" pendingOnly={false} onResolve={setResolving} /> }
        ]}
      />
      {resolving !== null ? (
        <ResolveDialog
          key={`${resolving.proposal.id}:${resolving.decision}`}
          proposal={resolving.proposal}
          decision={resolving.decision}
          sameCount={resolving.sameCount}
          onClose={() => setResolving(null)}
        />
      ) : null}
    </div>
  );
}

function GroupList({ pendingOnly, onResolve }: { pendingOnly: boolean; onResolve: (resolving: Resolving) => void }): ReactNode {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  return (
    <ul className={styles.list}>
      {cursors.map((cursor, index) => (
        <GroupPage
          key={cursor ?? "first"}
          cursor={cursor}
          pendingOnly={pendingOnly}
          isLast={index === cursors.length - 1}
          onMore={(next) => setCursors([...cursors, next])}
          onResolve={onResolve}
        />
      ))}
    </ul>
  );
}

interface GroupPageProps {
  cursor: string | null;
  pendingOnly: boolean;
  isLast: boolean;
  onMore: (cursor: string) => void;
  onResolve: (resolving: Resolving) => void;
}

function GroupPage({ cursor, pendingOnly, isLast, onMore, onResolve }: GroupPageProps): ReactNode {
  const page = useGetProposalGroupsQuery({ limit: PAGE_SIZE, ...(pendingOnly ? { status: "pending" as const } : {}), ...(cursor === null ? {} : { cursor }) });
  const denial = useAccessDenial(page.error);
  if (page.currentData === undefined) {
    if (denial !== null) {
      return (
        <li>
          <AccessDeniedState denial={denial} verifyTitle={ADMIN_VERIFY_TITLE} forbiddenTitle="No tienes acceso a las propuestas" />
        </li>
      );
    }
    if (page.isError) {
      return (
        <li>
          <EmptyState icon="⚠️" title="No pudimos cargar las propuestas" action={<Button onClick={() => void page.refetch()}>Reintentar</Button>} />
        </li>
      );
    }
    return (
      <li>
        <Skeleton shape="block" height="8rem" />
      </li>
    );
  }
  const { items, nextCursor } = page.currentData;
  if (items.length === 0 && cursor === null) {
    return (
      <li>
        <EmptyState icon="✅" title={pendingOnly ? "No hay propuestas pendientes." : "Todavía no hay propuestas."} />
      </li>
    );
  }
  return (
    <>
      {items.map((group) => (
        <li key={group.pairKey}>
          <ProposalGroupCard group={group} onResolve={onResolve} />
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

function Side({ person }: { person: PersonSummary | null }): ReactNode {
  if (person === null) {
    return (
      <div className={styles.side}>
        <span className={styles.sideName}>{DELETED_PERSON}</span>
      </div>
    );
  }
  return (
    <div className={styles.side}>
      <AvatarCircle name={person.fullName} src={person.avatarUrl ?? undefined} size="sm" decorative />
      <Link to={`/admin/familia/${encodeURIComponent(person.id)}`} className={styles.sideName}>
        {displayName(person)}
        {person.deceased ? " †" : ""}
      </Link>
    </div>
  );
}

/** One pair: both people side by side, every proposal about them, and the decision buttons. */
function ProposalGroupCard({ group, onResolve }: { group: TreeLinkProposalGroup; onResolve: (resolving: Resolving) => void }): ReactNode {
  const [first] = group.proposals;
  if (first === undefined) return null;
  const pending = group.proposals.filter((proposal) => proposal.status === "pending");
  // Act on the oldest pending one; the same kind and relation follow it (`applyToPair`).
  const target = pending.at(-1);
  const sameCount =
    target === undefined
      ? 0
      : pending.filter(
          (proposal) =>
            proposal.id !== target.id &&
            proposal.kind === target.kind &&
            proposal.relation === target.relation &&
            // `parent_of` is directional: only the same direction follows (server rule).
            (target.relation !== "parent_of" || (proposal.from?.id === target.from?.id && proposal.to?.id === target.to?.id))
        ).length;
  return (
    <article className={styles.item} aria-label={describeProposal(target ?? first)}>
      <h2 className={styles.itemTitle}>{describeProposal(target ?? first)}</h2>
      <div className={styles.sides}>
        <Side person={first.from} />
        <Side person={first.to} />
      </div>
      <ul className={styles.list}>
        {group.proposals.map((proposal) => (
          <li key={proposal.id} className={styles.item}>
            <div className={styles.itemHeader}>
              <span className={styles.muted}>
                {proposal.proposedByName ?? "Una cuenta eliminada"} · {formatDate(proposal.createdAt, PORTAL_TIME_ZONE)}
                {proposal.id !== target?.id && proposal.kind !== target?.kind ? ` · ${describeProposal(proposal)}` : ""}
              </span>
              <Badge tone={PROPOSAL_STATUS_TONES[proposal.status]}>{PROPOSAL_STATUS_LABELS[proposal.status]}</Badge>
            </div>
            {proposal.note !== null ? <p className={styles.note}>{proposal.note}</p> : null}
            {proposal.resolutionNote !== null ? (
              <p className={styles.note}>
                <strong>Tu nota:</strong> {proposal.resolutionNote}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {target !== undefined ? (
        <div className={styles.actions}>
          <Button size="sm" onClick={() => onResolve({ proposal: target, decision: "approve", sameCount })}>
            Aprobar…
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onResolve({ proposal: target, decision: "reject", sameCount })}>
            Rechazar…
          </Button>
        </div>
      ) : null}
    </article>
  );
}
