import type { PossibleDuplicate } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Badge } from "../../../../shared/ui/Badge";
import { Button } from "../../../../shared/ui/Button";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { useGetFamilyDuplicatesQuery } from "../api";
import { DUPLICATE_REASON_LABELS, describeCandidate } from "../lib/merge";
import { type MergePair, MergeReview } from "./MergeWith";
import styles from "./merge.module.css";

const PAGE_SIZE = 20;

/**
 * "Posibles duplicados" (WP-4.5): pairs of tree people that may be the same
 * human (same name and compatible years, or an invite that could not be
 * linked), each with "Revisar" to open the merge preview.
 */
export function DuplicateList(): ReactNode {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pair, setPair] = useState<MergePair | null>(null);
  return (
    <div className={styles.section}>
      {cursors.map((cursor, index) => (
        <DuplicatePage
          key={cursor ?? "first"}
          cursor={cursor}
          isLast={index === cursors.length - 1}
          onReview={setPair}
          onMore={(next) => setCursors([...cursors, next])}
        />
      ))}
      <MergeReview pair={pair} onChange={setPair} />
    </div>
  );
}

interface DuplicatePageProps {
  cursor: string | null;
  isLast: boolean;
  onReview: (pair: MergePair) => void;
  onMore: (cursor: string) => void;
}

function DuplicatePage({ cursor, isLast, onReview, onMore }: DuplicatePageProps): ReactNode {
  const result = useGetFamilyDuplicatesQuery({ limit: PAGE_SIZE, ...(cursor === null ? {} : { cursor }) });
  if (result.currentData === undefined) {
    if (result.isError) {
      return <EmptyState icon="⚠️" title="No pudimos buscar duplicados" action={<Button onClick={() => void result.refetch()}>Reintentar</Button>} />;
    }
    return <Skeleton shape="block" height="6rem" />;
  }
  const { items, nextCursor } = result.currentData;
  if (items.length === 0 && cursor === null) {
    return <EmptyState icon="✅" title="No encontramos posibles duplicados." />;
  }
  return (
    <>
      <ul className={styles.pairs}>
        {items.map((item) => (
          <DuplicatePair key={`${item.keep.id}:${item.duplicate.id}`} item={item} onReview={onReview} />
        ))}
      </ul>
      {isLast && nextCursor !== null ? (
        <Button variant="secondary" fullWidth onClick={() => onMore(nextCursor)}>
          Cargar más
        </Button>
      ) : null}
    </>
  );
}

function DuplicatePair({ item, onReview }: { item: PossibleDuplicate; onReview: (pair: MergePair) => void }): ReactNode {
  const label = `${item.keep.fullName} y ${item.duplicate.fullName}`;
  return (
    <li className={styles.pair} aria-label={label}>
      <div className={styles.pairPeople}>
        {[item.keep, item.duplicate].map((person) => (
          <div key={person.id} className={styles.sideText}>
            <p className={styles.sideName}>{person.fullName}</p>
            <span className={styles.meta}>{describeCandidate(person)}</span>
          </div>
        ))}
      </div>
      <div className={styles.pairActions}>
        <Badge tone={item.reason === "invite_fallback" ? "accent" : "neutral"}>{DUPLICATE_REASON_LABELS[item.reason]}</Badge>
        {item.mergeable ? (
          <Button size="sm" aria-label={`Revisar: ${label}`} onClick={() => onReview({ keepId: item.keep.id, duplicateId: item.duplicate.id })}>
            Revisar
          </Button>
        ) : (
          <span className={styles.meta}>Las dos tienen cuenta: no se pueden fusionar.</span>
        )}
      </div>
    </li>
  );
}
