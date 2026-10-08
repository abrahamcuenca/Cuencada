import type { PersonDetails } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Button } from "../../../../shared/ui/Button";
import { Dialog } from "../../../../shared/ui/Dialog";
import { PersonSearch } from "../../components/PersonSearch";
import styles from "../admin.module.css";
import { MergeSheet } from "./MergeSheet";

/** A pair being reviewed: who stays and who is merged away. */
export interface MergePair {
  keepId: string;
  duplicateId: string;
}

/**
 * The merge preview for `pair` (or nothing), with "Cambiar cuál se queda".
 * Shared by "Fusionar con…" and "Posibles duplicados".
 */
export function MergeReview({ pair, onChange }: { pair: MergePair | null; onChange: (pair: MergePair | null) => void }): ReactNode {
  if (pair === null) return null;
  return (
    <MergeSheet
      key={`${pair.keepId}:${pair.duplicateId}`}
      keepId={pair.keepId}
      duplicateId={pair.duplicateId}
      onClose={() => onChange(null)}
      onSwap={() => onChange({ keepId: pair.duplicateId, duplicateId: pair.keepId })}
    />
  );
}

/**
 * "Fusionar con…" on an admin person page (WP-4.5): search for the
 * duplicate, then review the merge with this person as the one that stays.
 */
export function MergeWith({ person }: { person: PersonDetails }): ReactNode {
  const [searching, setSearching] = useState(false);
  const [pair, setPair] = useState<MergePair | null>(null);

  return (
    <section aria-labelledby="fusionar-persona" className={styles.panel}>
      <h2 id="fusionar-persona" className={styles.sectionTitle}>
        Fusionar con otra persona
      </h2>
      <p className={styles.muted}>
        ¿{person.fullName} aparece dos veces en el árbol? Elige a la otra persona: verás qué datos y relaciones se combinan antes de confirmar.
      </p>
      <Button variant="secondary" onClick={() => setSearching(true)}>
        Fusionar con…
      </Button>
      <Dialog open={searching} onClose={() => setSearching(false)} title="Fusionar con…" description={`¿Con quién está repetida ${person.fullName}?`}>
        <PersonSearch
          label="Buscar persona"
          actionLabel="Elegir a"
          autoFocus
          excludeIds={new Set([person.id])}
          excludedReason="Es esta misma persona"
          onPick={(picked) => {
            setSearching(false);
            setPair({ keepId: person.id, duplicateId: picked.id });
          }}
        />
      </Dialog>
      <MergeReview pair={pair} onChange={setPair} />
    </section>
  );
}
