import type { PersonSummary } from "@cuencada/types";
import { type ReactNode, useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getApiErrorCode, isAbortError } from "../../../../shared/api/errors";
import { AvatarCircle } from "../../../../shared/ui/AvatarCircle";
import { Badge } from "../../../../shared/ui/Badge";
import { Button } from "../../../../shared/ui/Button";
import { Card } from "../../../../shared/ui/Card";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { TextInput } from "../../../../shared/ui/TextInput";
import { useToast } from "../../../../shared/ui/Toast";
import { cx } from "../../../../shared/ui/cx";
import { useAccessDenial } from "../../../auth/accessDenied";
import { AccessDeniedState } from "../../../auth/components/AccessDeniedState";
import { useSearchPeopleQuery } from "../../api";
import familyStyles from "../../family.module.css";
import { type FieldErrors, serverErrorToFieldErrors } from "../../lib/forms";
import { useDebouncedValue } from "../../lib/hooks";
import { displayName } from "../../lib/tree";
import styles from "../admin.module.css";
import { useCreatePersonMutation } from "../api";
import { PERSON_FORM_FIELDS, PersonForm, type PersonFormSubmit } from "../components/PersonForm";

const PAGE_SIZE = 30;

/** Title of the 403 state for an admin whose email isn't verified (the tree endpoints require it). */
export const ADMIN_VERIFY_TITLE = "Verifica tu correo para administrar el árbol";

/**
 * `/admin/familia`: everyone in the tree, searchable, with "Nueva persona".
 * Phone-first: one column of tappable rows; "Cargar más" pages with the cursor.
 */
export function AdminFamilyPage(): ReactNode {
  const [creating, setCreating] = useState(false);
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim());
  const [paging, setPaging] = useState<{ q: string; cursors: Array<string | null> }>({ q: "", cursors: [null] });
  // A new search starts again from the first page.
  const cursors = paging.q === q ? paging.cursors : [null];
  const [create] = useCreatePersonMutation();
  const navigate = useNavigate();
  const toast = useToast();
  const searchId = useId();

  const submit = async (request: PersonFormSubmit): Promise<FieldErrors | null> => {
    if (request.mode !== "create") return null;
    try {
      const person = await create(request.body).unwrap();
      toast.show({
        message: `Agregamos a ${person.fullName}. Ahora puedes sumar sus relaciones.`,
        tone: "success"
      });
      navigate(`/admin/familia/${encodeURIComponent(person.id)}`);
      return null;
    } catch (error) {
      if (isAbortError(error)) return null;
      if (getApiErrorCode(error) === "CONFLICT") return { userId: "Esa cuenta ya está vinculada a otra persona." };
      return serverErrorToFieldErrors(error, "No pudimos crear a la persona. Inténtalo otra vez.", PERSON_FORM_FIELDS);
    }
  };

  return (
    <div className={cx("cu-container", styles.page)}>
      <Link to="/admin" className={styles.back}>
        ‹ Administración
      </Link>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Personas y árbol</h1>
        {creating ? null : (
          <Button icon="＋" onClick={() => setCreating(true)}>
            Nueva persona
          </Button>
        )}
      </div>

      {creating ? (
        <section aria-labelledby="nueva-persona" className={styles.panel}>
          <h2 id="nueva-persona" className={styles.sectionTitle}>
            Nueva persona
          </h2>
          <p className={styles.muted}>Después de crearla podrás agregar sus padres, pareja e hijos.</p>
          <PersonForm person={null} submitLabel="Crear persona" onSubmit={submit} onCancel={() => setCreating(false)} />
        </section>
      ) : null}

      <section aria-label="Lista de personas" className={styles.panel}>
        <div className={familyStyles.search}>
          <label htmlFor={searchId} className={familyStyles.searchLabel}>
            Buscar persona
          </label>
          <TextInput
            id={searchId}
            type="search"
            value={text}
            maxLength={100}
            placeholder="Nombre o apodo"
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <ul className={styles.rows}>
          {cursors.map((cursor, index) => (
            <PeoplePage
              key={cursor ?? "first"}
              q={q}
              cursor={cursor}
              isLast={index === cursors.length - 1}
              onMore={(next) => setPaging({ q, cursors: [...cursors, next] })}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

interface PeoplePageProps {
  q: string;
  cursor: string | null;
  isLast: boolean;
  onMore: (cursor: string) => void;
}

/** One page of people; the last page renders "Cargar más" when there is a next cursor. */
function PeoplePage({ q, cursor, isLast, onMore }: PeoplePageProps): ReactNode {
  const page = useSearchPeopleQuery({
    limit: PAGE_SIZE,
    ...(q === "" ? {} : { q }),
    ...(cursor === null ? {} : { cursor })
  });
  const denial = useAccessDenial(page.error);

  if (page.currentData === undefined) {
    if (denial !== null) {
      return (
        <li>
          <AccessDeniedState denial={denial} verifyTitle={ADMIN_VERIFY_TITLE} forbiddenTitle="No tienes acceso a las personas del árbol" />
        </li>
      );
    }
    if (page.isError) {
      return (
        <li>
          <EmptyState icon="⚠️" title="No pudimos cargar a las personas" action={<Button onClick={() => void page.refetch()}>Reintentar</Button>} />
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
        {q === "" ? (
          <EmptyState icon="🌳" title="Todavía no hay árbol" description="Empieza agregando a la primera persona con «Nueva persona»." />
        ) : (
          <EmptyState icon="🔎" title={`No encontramos a nadie con «${q}»`} description="Revisa la ortografía o busca por apodo." />
        )}
      </li>
    );
  }
  return (
    <>
      {items.map((person) => (
        <li key={person.id}>
          <PersonRow person={person} />
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

function PersonRow({ person }: { person: PersonSummary }): ReactNode {
  return (
    <Link to={`/admin/familia/${encodeURIComponent(person.id)}`} className={styles.cardLink}>
      <Card padding="sm" className={styles.row}>
        <AvatarCircle name={person.fullName} src={person.avatarUrl ?? undefined} size="sm" decorative />
        <div className={styles.rowMain}>
          <h2 className={styles.rowTitle}>
            {displayName(person)}
            {person.deceased ? " †" : ""}
          </h2>
        </div>
        {person.userId === null ? <Badge tone="neutral">Sin cuenta</Badge> : <Badge tone="success">Con cuenta</Badge>}
        <span aria-hidden="true" className={styles.chevron}>
          ›
        </span>
      </Card>
    </Link>
  );
}
