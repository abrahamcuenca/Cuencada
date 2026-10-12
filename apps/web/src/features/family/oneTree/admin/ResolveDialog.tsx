import { TREE_LINK_NOTE_MAX_LENGTH, type TreeLinkProposal } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { getApiErrorMessage, isAbortError, parseApiError } from "../../../../shared/api/errors";
import { Button } from "../../../../shared/ui/Button";
import { Dialog } from "../../../../shared/ui/Dialog";
import { Field } from "../../../../shared/ui/Field";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { TextArea } from "../../../../shared/ui/TextArea";
import { useToast } from "../../../../shared/ui/Toast";
import { useGetMergePreviewQuery } from "../../admin/api";
import { MERGE_BLOCKER_TEXT, MERGE_CONFLICT_REASONS, describeMergeEdge } from "../../admin/lib/merge";
import { useResolveProposalMutation } from "../api";
import { describeProposal } from "../labels";
import styles from "../oneTree.module.css";

/** What the admin is doing. */
export type ResolveDecision = "approve" | "reject";

/** Props for {@link ResolveDialog}. */
export interface ResolveDialogProps {
  proposal: TreeLinkProposal;
  decision: ResolveDecision;
  /** How many other pending proposals of the pair get the same decision. */
  sameCount: number;
  onClose: () => void;
}

/** Spanish lines for a refused resolve (the server's message plus each conflict detail). */
export function resolveErrorLines(error: unknown): string[] {
  const parsed = parseApiError(error);
  if (parsed === null) return [getApiErrorMessage(error)];
  const details = (parsed.error.details ?? []).map((detail) => detail.message).filter((message) => message !== parsed.error.message);
  return [parsed.error.message, ...details];
}

/**
 * Approve or reject one proposal (and, by default, the pair's other pending
 * proposals of the same kind). Approving "Es la misma persona" shows the
 * merge preview first (what moves, conflicts and blockers, with "Cambiar
 * cuál se queda"); a conflict answer keeps the proposal pending and is
 * explained here. The note goes to the proposer only.
 */
export function ResolveDialog({ proposal, decision, sameCount, onClose }: ResolveDialogProps): ReactNode {
  const [note, setNote] = useState("");
  const [swap, setSwap] = useState(false);
  const [errorLines, setErrorLines] = useState<string[]>([]);
  const [resolve, state] = useResolveProposalMutation();
  const toast = useToast();
  const from = proposal.from;
  const to = proposal.to;
  const merging = decision === "approve" && proposal.kind === "same_person" && from !== null && to !== null;
  const keep = swap ? from : to;
  const duplicate = swap ? to : from;

  const submit = async (): Promise<void> => {
    const trimmed = note.trim();
    try {
      await resolve({
        id: proposal.id,
        decision,
        note: trimmed === "" ? null : trimmed,
        applyToPair: true,
        ...(merging && keep !== null ? { keepPersonId: keep.id } : {})
      }).unwrap();
      toast.show({ message: decision === "approve" ? "Aprobamos la propuesta: el árbol ya está unido." : "Rechazamos la propuesta.", tone: "success" });
      onClose();
    } catch (error) {
      if (!isAbortError(error)) setErrorLines(resolveErrorLines(error));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={decision === "approve" ? "Aprobar propuesta" : "Rechazar propuesta"}
      description={describeProposal(proposal)}
    >
      <div className={styles.form}>
        {merging && keep !== null && duplicate !== null ? (
          <MergeSummary keepId={keep.id} duplicateId={duplicate.id} keepName={keep.fullName} duplicateName={duplicate.fullName} onSwap={() => setSwap((value) => !value)} />
        ) : null}
        {decision === "approve" && proposal.kind === "relate" ? (
          <p className={styles.muted}>Se creará la relación tal como la propusieron. Si rompe una regla del árbol, te lo diremos y la propuesta seguirá pendiente.</p>
        ) : null}
        {sameCount > 0 ? (
          <p className={styles.muted}>
            {sameCount === 1 ? "Otra propuesta igual" : `Otras ${sameCount} propuestas iguales`} de este par recibirán la misma respuesta.
          </p>
        ) : null}
        <Field label="Nota para quien propuso" hint="Solo la ve quien hizo la propuesta." showOptional>
          {(control) => <TextArea {...control} rows={3} maxLength={TREE_LINK_NOTE_MAX_LENGTH} value={note} onChange={(event) => setNote(event.target.value)} />}
        </Field>
        {errorLines.length > 0 ? (
          <div role="alert">
            {errorLines.map((line) => (
              <p key={line} className={styles.error}>
                {line}
              </p>
            ))}
          </div>
        ) : null}
        <div className={styles.actions}>
          <Button variant={decision === "approve" ? "primary" : "danger"} loading={state.isLoading} onClick={() => void submit()}>
            {decision === "approve" ? (merging ? "Aprobar y fusionar" : "Aprobar") : "Rechazar"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

interface MergeSummaryProps {
  keepId: string;
  duplicateId: string;
  keepName: string;
  duplicateName: string;
  onSwap: () => void;
}

/** The merge preview, read-only: who stays, what moves, and what blocks it. */
function MergeSummary({ keepId, duplicateId, keepName, duplicateName, onSwap }: MergeSummaryProps): ReactNode {
  const preview = useGetMergePreviewQuery({ keepId, duplicateId }, { refetchOnMountOrArgChange: true });
  const data = preview.currentData;
  return (
    <section aria-label="Vista previa de la fusión" className={styles.form}>
      <p>
        Se queda <strong>{keepName}</strong>; <strong>{duplicateName}</strong> se fusiona en ella y desaparece del árbol.
      </p>
      <div className={styles.actions}>
        <Button variant="secondary" size="sm" onClick={onSwap}>
          Cambiar cuál se queda
        </Button>
      </div>
      {data === undefined ? (
        preview.isError ? (
          <p className={styles.error}>{getApiErrorMessage(preview.error)}</p>
        ) : (
          <Skeleton shape="block" height="4rem" />
        )
      ) : (
        <>
          <p className={styles.muted}>
            {data.relationships.moved.length === 1 ? "1 relación pasa" : `${data.relationships.moved.length} relaciones pasan`} a {keepName}.
          </p>
          {data.blockers.map((code) => (
            <p key={code} className={styles.error}>
              {MERGE_BLOCKER_TEXT[code] ?? code}
            </p>
          ))}
          {data.relationships.conflicts.length > 0 ? (
            <ul className={styles.conflicts} aria-label="Relaciones en conflicto">
              {data.relationships.conflicts.map((edge) => (
                <li key={edge.id}>
                  {describeMergeEdge(edge)}: {MERGE_CONFLICT_REASONS[edge.reason]}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <p className={styles.muted}>Podrás deshacer la fusión desde «Actividad del árbol» mientras nadie cambie a {keepName}.</p>
    </section>
  );
}
