import type { BranchMatch, DisconnectedBranch, PersonSummary } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { getApiErrorMessage, isAbortError } from "../../../../shared/api/errors";
import { Badge } from "../../../../shared/ui/Badge";
import { Button } from "../../../../shared/ui/Button";
import { Dialog } from "../../../../shared/ui/Dialog";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { useToast } from "../../../../shared/ui/Toast";
import { cx } from "../../../../shared/ui/cx";
import { useAccessDenial } from "../../../auth/accessDenied";
import { AccessDeniedState } from "../../../auth/components/AccessDeniedState";
import adminStyles from "../../admin/admin.module.css";
import { type MergePair, MergeReview } from "../../admin/components/MergeWith";
import { ADMIN_VERIFY_TITLE } from "../../admin/pages/AdminFamilyPage";
import { PersonSearch } from "../../components/PersonSearch";
import { displayName } from "../../lib/tree";
import { useGetAdminFamilySettingsQuery, useGetDisconnectedBranchesQuery, useUpdateFamilySettingsMutation } from "../api";
import { BRANCH_REASON_LABELS } from "../labels";
import styles from "../oneTree.module.css";

const PAGE_SIZE = 10;

/**
 * `/admin/familia/ramas` ("Ramas sin conectar", WP-6.4): the root ancestor
 * setting ("Raíz del árbol") and every group of people the root cannot
 * reach, largest first, with suggested matches to merge ("Revisar fusión")
 * or open the person to link them. No account ids: linked accounts are a count.
 */
export function BranchesPage(): ReactNode {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pair, setPair] = useState<MergePair | null>(null);
  return (
    <div className={cx("cu-container", adminStyles.page)}>
      <Link to="/admin" className={adminStyles.back}>
        ‹ Panel
      </Link>
      <div className={adminStyles.pageHeader}>
        <h1 className={adminStyles.pageTitle}>Ramas sin conectar</h1>
      </div>
      <RootSetting />
      <section aria-labelledby="ramas-lista" className={styles.form}>
        <h2 id="ramas-lista" className={adminStyles.sectionTitle}>
          Ramas que no llegan a la raíz
        </h2>
        <p className={styles.muted}>
          Grupos de personas relacionadas entre sí pero sin camino hasta la raíz. Casi siempre es alguien repetido: revisa las coincidencias y fusiona, o conecta a la persona
          con sus parientes.
        </p>
        <ul className={styles.list}>
          {cursors.map((cursor, index) => (
            <BranchPage
              key={cursor ?? "first"}
              cursor={cursor}
              isLast={index === cursors.length - 1}
              onMore={(next) => setCursors([...cursors, next])}
              onReview={setPair}
            />
          ))}
        </ul>
      </section>
      <MergeReview pair={pair} onChange={setPair} />
    </div>
  );
}

/** "Raíz del árbol": the oldest ancestor that anchors "Árbol completo" and this report. */
function RootSetting(): ReactNode {
  const settings = useGetAdminFamilySettingsQuery();
  const [update, state] = useUpdateFamilySettingsMutation();
  const [choosing, setChoosing] = useState(false);
  const toast = useToast();
  const denial = useAccessDenial(settings.error);
  const save = async (rootPersonId: string | null): Promise<void> => {
    try {
      await update({ rootPersonId }).unwrap();
      setChoosing(false);
      toast.show({ message: rootPersonId === null ? "Quitamos la raíz del árbol." : "Guardamos la raíz del árbol.", tone: "success" });
    } catch (error) {
      if (!isAbortError(error)) toast.show({ message: getApiErrorMessage(error), tone: "danger" });
    }
  };
  if (settings.currentData === undefined) {
    if (denial !== null) return <AccessDeniedState denial={denial} verifyTitle={ADMIN_VERIFY_TITLE} forbiddenTitle="No tienes acceso a la raíz del árbol" />;
    return settings.isError ? <p className={styles.error}>No pudimos cargar la raíz del árbol.</p> : <Skeleton shape="block" height="5rem" />;
  }
  const root = settings.currentData.root;
  return (
    <section aria-labelledby="raiz-arbol" className={styles.item}>
      <h2 id="raiz-arbol" className={adminStyles.sectionTitle}>
        Raíz del árbol
      </h2>
      <p className={styles.muted}>
        El ancestro más antiguo (por ejemplo, el bisabuelo). «Árbol completo» muestra a sus descendientes y esta página busca a quien no llega hasta él.
      </p>
      <p className={styles.itemTitle}>{root === null ? "Sin raíz todavía" : displayName(root)}</p>
      <div className={styles.actions}>
        <Button size="sm" onClick={() => setChoosing(true)}>
          {root === null ? "Elegir la raíz" : "Cambiar la raíz"}
        </Button>
        {root !== null ? (
          <Button size="sm" variant="ghost" loading={state.isLoading} onClick={() => void save(null)}>
            Quitar la raíz
          </Button>
        ) : null}
      </div>
      <Dialog open={choosing} onClose={() => setChoosing(false)} title="Raíz del árbol" description="Busca al ancestro más antiguo de la familia.">
        {choosing ? <PersonSearch label="Buscar persona" actionLabel="Elegir a" autoFocus onPick={(person) => void save(person.id)} /> : null}
      </Dialog>
    </section>
  );
}

interface BranchPageProps {
  cursor: string | null;
  isLast: boolean;
  onMore: (cursor: string) => void;
  onReview: (pair: MergePair) => void;
}

function BranchPage({ cursor, isLast, onMore, onReview }: BranchPageProps): ReactNode {
  const report = useGetDisconnectedBranchesQuery({ limit: PAGE_SIZE, ...(cursor === null ? {} : { cursor }) });
  if (report.currentData === undefined) {
    if (report.isError) {
      return (
        <li>
          <EmptyState icon="⚠️" title="No pudimos revisar las ramas" action={<Button onClick={() => void report.refetch()}>Reintentar</Button>} />
        </li>
      );
    }
    return (
      <li>
        <Skeleton shape="block" height="8rem" />
      </li>
    );
  }
  const { items, nextCursor, rootPersonId } = report.currentData;
  if (items.length === 0 && cursor === null) {
    return (
      <li>
        <EmptyState
          icon="🌳"
          title="Todo el árbol está conectado"
          description={rootPersonId === null ? "Elige la raíz del árbol para revisar las ramas desde ella." : "Cada persona con parientes llega hasta la raíz."}
        />
      </li>
    );
  }
  return (
    <>
      {items.map((branch) => (
        <li key={branch.id}>
          <BranchCard branch={branch} onReview={onReview} />
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

function personLink(person: PersonSummary): ReactNode {
  return (
    <Link to={`/admin/familia/${encodeURIComponent(person.id)}`} className={styles.sideName}>
      {displayName(person)}
      {person.deceased ? " †" : ""}
    </Link>
  );
}

function BranchCard({ branch, onReview }: { branch: DisconnectedBranch; onReview: (pair: MergePair) => void }): ReactNode {
  const [lead] = branch.people;
  return (
    <article className={styles.item} aria-label={`Rama de ${lead?.fullName ?? "personas"}`}>
      <div className={styles.itemHeader}>
        <h3 className={styles.itemTitle}>Rama de {lead === undefined ? "personas" : displayName(lead)}</h3>
        <span className={styles.muted}>
          {branch.size === 1 ? "1 persona" : `${branch.size} personas`} · {branch.linkedAccounts === 1 ? "1 con cuenta" : `${branch.linkedAccounts} con cuenta`}
        </span>
      </div>
      <p className={styles.muted}>
        {branch.people.map((person, index) => (
          <span key={person.id}>
            {index > 0 ? ", " : ""}
            {personLink(person)}
          </span>
        ))}
      </p>
      {branch.suggestedMatches.length === 0 ? (
        <p className={styles.muted}>Sin coincidencias claras: abre a una persona de la rama y conéctala con sus parientes.</p>
      ) : (
        <ul className={styles.list} aria-label="Posibles coincidencias">
          {branch.suggestedMatches.map((match) => (
            <li key={`${match.person.id}:${match.candidate.id}`}>
              <MatchRow match={match} onReview={onReview} />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function MatchRow({ match, onReview }: { match: BranchMatch; onReview: (pair: MergePair) => void }): ReactNode {
  return (
    <div className={styles.item}>
      <div className={styles.sides}>
        <div className={styles.side}>{personLink(match.person)}</div>
        <div className={styles.side}>{personLink(match.candidate)}</div>
      </div>
      <div className={styles.reasons}>
        {match.reasons.map((reason) => (
          <Badge key={reason} tone="neutral">
            {BRANCH_REASON_LABELS[reason]}
          </Badge>
        ))}
        <Badge tone="accent">{`${match.score}%`}</Badge>
      </div>
      <div className={styles.actions}>
        <Button
          size="sm"
          aria-label={`Revisar fusión: ${match.person.fullName} con ${match.candidate.fullName}`}
          onClick={() => onReview({ keepId: match.candidate.id, duplicateId: match.person.id })}
        >
          Revisar fusión
        </Button>
        <Button size="sm" variant="ghost" to={`/admin/familia/${encodeURIComponent(match.person.id)}`}>
          Conectar a mano
        </Button>
      </div>
    </div>
  );
}
