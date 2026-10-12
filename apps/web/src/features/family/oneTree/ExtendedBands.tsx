import type { PersonSummary } from "@cuencada/types";
import type { ReactNode } from "react";
import { useMediaQuery } from "../../../shared/lib/useMediaQuery";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { type OpenPerson, PersonButton } from "../components/TreeParts";
import { useGetExtendedFamilyQuery } from "./api";
import styles from "./oneTree.module.css";

/** Props for {@link ExtendedBands}. */
export interface ExtendedBandsProps {
  personId: string;
  onOpen: OpenPerson;
}

/**
 * "Tíos", "Primos" and "Tíos abuelos" (WP-6.4), computed on the server.
 * Each band is a native `<details>`: collapsed on phones (the tree stays
 * short), open from 700px. Empty bands are not shown; errors fail quietly
 * (the core tree above still works).
 */
export function ExtendedBands({ personId, onOpen }: ExtendedBandsProps): ReactNode {
  const wide = useMediaQuery("(min-width: 700px)");
  const result = useGetExtendedFamilyQuery(personId);
  const data = result.currentData;
  if (data === undefined) {
    return result.isError ? null : <Skeleton shape="block" height="3rem" />;
  }
  const bands: Array<{ id: string; title: string; people: PersonSummary[] }> = [
    { id: "tios", title: "Tíos", people: data.tios },
    { id: "primos", title: "Primos", people: data.primos },
    { id: "tios-abuelos", title: "Tíos abuelos", people: data.tiosAbuelos }
  ].filter((band) => band.people.length > 0);
  if (bands.length === 0) return null;
  return (
    <div className={styles.bands}>
      {bands.map((band) => (
        // Re-mounted when the breakpoint changes, so `open` follows it (the user can still toggle).
        <details key={`${band.id}-${wide ? "open" : "closed"}`} className={styles.bandGroup} open={wide}>
          <summary id={`arbol-${band.id}`} className={styles.bandSummary}>
            {band.title} ({band.people.length})
          </summary>
          <ul className={styles.bandPeople} aria-labelledby={`arbol-${band.id}`}>
            {band.people.map((person) => (
              <li key={person.id}>
                <PersonButton person={person} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </details>
      ))}
      {data.truncated ? <p className={styles.bandNote}>Mostramos a los primeros 200 de cada grupo.</p> : null}
    </div>
  );
}
