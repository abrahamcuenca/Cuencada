import type { FamilyActivityQueryRequest, PersonRevision } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { getApiErrorMessage, isAbortError } from "../../../../shared/api/errors";
import { Button } from "../../../../shared/ui/Button";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { useToast } from "../../../../shared/ui/Toast";
import { useGetFamilyActivityQuery, useGetPersonRevisionsQuery, useRevertRevisionMutation } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { RevisionList, revisionSummary } from "./RevisionList";

const PAGE_SIZE = 20;

/** Shown in the "Deshacer" confirmation: restored people and edges are recorded as the admin's (WP-4.1). */
export const REVERT_PROVENANCE_NOTE = "Al deshacer, la persona y sus relaciones quedarán registradas como agregadas por un administrador.";

/** Shown instead when undoing a merge (WP-4.5): the duplicate comes back as it was, provenance included. */
export const REVERT_MERGE_NOTE =
  "Al deshacer, las dos personas vuelven a quedar separadas, con sus datos, relaciones y cuenta como estaban antes de fusionarlas. Solo se puede si nadie las cambió después.";

/** The note for the "Deshacer" confirmation of `revision`. */
export function revertNote(revision: PersonRevision): string {
  return revision.action === "person.merge" ? REVERT_MERGE_NOTE : REVERT_PROVENANCE_NOTE;
}

/** Which list to show. */
export type RevisionSource =
  | { kind: "person"; personId: string }
  | { kind: "activity"; filters: Omit<FamilyActivityQueryRequest, "cursor" | "limit"> };

/** Props for {@link RevisionFeed}. */
export interface RevisionFeedProps {
  source: RevisionSource;
  /** "Solo de …" on actor names (activity). */
  onFilterActor?: ((actor: { userId: string; displayName: string }) => void) | undefined;
  /** Text of the empty state. */
  emptyTitle: string;
}

/**
 * A paged list of family changes with "Deshacer". Pages load with "Cargar
 * más" (keyset cursors from the server); a refused undo (already undone,
 * stale, would break a rule) shows the server's Spanish reason.
 */
export function RevisionFeed({ source, onFilterActor, emptyTitle }: RevisionFeedProps): ReactNode {
  const key = JSON.stringify(source);
  const [paging, setPaging] = useState<{ key: string; cursors: Array<string | null> }>({ key, cursors: [null] });
  // A new source (other person, other filter) starts again from the first page.
  const cursors = paging.key === key ? paging.cursors : [null];
  const [revert] = useRevertRevisionMutation();
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PersonRevision | null>(null);
  const toast = useToast();

  const onRevert = async (revision: PersonRevision): Promise<void> => {
    setRevertingId(revision.id);
    try {
      await revert(revision.id).unwrap();
      toast.show({ message: "Deshicimos el cambio.", tone: "success" });
    } catch (error) {
      if (!isAbortError(error)) toast.show({ message: getApiErrorMessage(error), tone: "danger" });
    } finally {
      setRevertingId(null);
      setConfirming(null);
    }
  };

  return (
    <div>
      {cursors.map((cursor, index) => (
        <RevisionPage
          key={cursor ?? "first"}
          source={source}
          cursor={cursor}
          isLast={index === cursors.length - 1}
          emptyTitle={emptyTitle}
          revertingId={revertingId}
          onRevert={setConfirming}
          onFilterActor={onFilterActor}
          onMore={(next) => setPaging({ key, cursors: [...cursors, next] })}
        />
      ))}
      <ConfirmDialog
        open={confirming !== null}
        title="¿Deshacer este cambio?"
        description={confirming === null ? "" : `«${revisionSummary(confirming)}». ${revertNote(confirming)}`}
        confirmLabel="Deshacer"
        busy={confirming !== null && revertingId === confirming.id}
        onConfirm={() => {
          if (confirming !== null) void onRevert(confirming);
        }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}

interface RevisionPageProps {
  source: RevisionSource;
  cursor: string | null;
  isLast: boolean;
  emptyTitle: string;
  revertingId: string | null;
  onRevert: (revision: PersonRevision) => void;
  onFilterActor: RevisionFeedProps["onFilterActor"];
  onMore: (cursor: string) => void;
}

function RevisionPage({ source, cursor, isLast, emptyTitle, revertingId, onRevert, onFilterActor, onMore }: RevisionPageProps): ReactNode {
  const paging = { limit: PAGE_SIZE, ...(cursor === null ? {} : { cursor }) };
  const person = useGetPersonRevisionsQuery(source.kind === "person" ? { personId: source.personId, ...paging } : { personId: "", ...paging }, {
    skip: source.kind !== "person"
  });
  const activity = useGetFamilyActivityQuery(source.kind === "activity" ? { ...source.filters, ...paging } : paging, {
    skip: source.kind !== "activity"
  });
  const result = source.kind === "person" ? person : activity;

  if (result.currentData === undefined) {
    if (result.isError) {
      return <EmptyState icon="⚠️" title="No pudimos cargar los cambios" action={<Button onClick={() => void result.refetch()}>Reintentar</Button>} />;
    }
    return <Skeleton shape="block" height="6rem" />;
  }
  const { items, nextCursor } = result.currentData;
  if (items.length === 0 && cursor === null) return <EmptyState icon="🕰️" title={emptyTitle} />;
  return (
    <>
      <RevisionList
        items={items}
        showPerson={source.kind === "activity"}
        onRevert={onRevert}
        revertingId={revertingId}
        onFilterActor={onFilterActor}
      />
      {isLast && nextCursor !== null ? (
        <Button variant="secondary" fullWidth onClick={() => onMore(nextCursor)}>
          Cargar más
        </Button>
      ) : null}
    </>
  );
}
