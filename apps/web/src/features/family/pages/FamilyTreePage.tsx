import { type FamilyTreeView, idSchema } from "@cuencada/types";
import { type ReactNode, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { getApiErrorCode } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { cx } from "../../../shared/ui/cx";
import { selectCurrentUser, selectIsAdmin } from "../../auth/authSlice";
import { useGetFamilyTreeQuery } from "../api";
import { PersonSearch } from "../components/PersonSearch";
import { Breadcrumbs, FocusCard, type OpenPerson, RelativeBand, SiblingStrip } from "../components/TreeParts";
import styles from "../family.module.css";
import { usePrefersReducedMotion } from "../lib/hooks";
import { type TrailEntry, type TreeLocationState, extendedGenerations, nextTrail, readTrail } from "../lib/tree";

// Only members editing their own node download the form.
const SelfEditDialog = lazy(async () => ({
  default: (await import("../components/SelfEditDialog")).SelfEditDialog
}));

/**
 * `/arbol/:personId?` (members): a person-centred family tree. Parents
 * above, partners beside (below on phones), children below, siblings in a
 * scrolling strip; tapping anyone navigates to them, so the URL, Back and
 * the breadcrumb trail all follow. Grandparents and grandchildren load on
 * "Ver más". Without `personId` the caller's own node is the focus.
 */
export function FamilyTreePage(): ReactNode {
  const { personId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const trail = useMemo(() => readTrail(location.state), [location.state]);
  const [expanded, setExpanded] = useState(false);
  const validId = personId === undefined || idSchema.safeParse(personId).success;

  const tree = useGetFamilyTreeQuery(personId === undefined ? { depth: expanded ? 2 : 1 } : { personId, depth: expanded ? 2 : 1 }, {
    skip: !validId
  });

  const open: OpenPerson = (person) => {
    const view = tree.data;
    const current: TrailEntry | null = view ? { id: view.focus.id, name: view.focus.fullName } : null;
    if (person.id === current?.id) return;
    const state: TreeLocationState = {
      trail: nextTrail(trail, current, person.id)
    };
    navigate(`/arbol/${encodeURIComponent(person.id)}`, { state });
  };

  return (
    <div className={cx("cu-container", styles.page)}>
      <header className={styles.header}>
        <h1 className={styles.title}>Árbol familiar</h1>
        <PersonSearch label="Buscar a un familiar" onPick={open} className={styles.headerSearch} />
      </header>
      {!validId ? (
        <NotFound />
      ) : tree.isError ? (
        <TreeError error={tree.error} hasPersonId={personId !== undefined} onRetry={() => void tree.refetch()} />
      ) : tree.data === undefined ? (
        <TreeSkeleton />
      ) : (
        <TreeView
          view={tree.data}
          busy={tree.isFetching}
          trail={trail}
          expanded={expanded}
          onToggleExpanded={() => setExpanded((value) => !value)}
          onOpen={open}
        />
      )}
    </div>
  );
}

interface TreeViewProps {
  view: FamilyTreeView;
  busy: boolean;
  trail: TrailEntry[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpen: OpenPerson;
}

function TreeView({ view, busy, trail, expanded, onToggleExpanded, onOpen }: TreeViewProps): ReactNode {
  const me = useAppSelector(selectCurrentUser);
  const isAdmin = useAppSelector(selectIsAdmin);
  const reducedMotion = usePrefersReducedMotion();
  const [editing, setEditing] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownFocus = useRef<string | null>(null);
  const { focus } = view;

  // After a re-centre (not on first load), move focus to the new person's
  // name so keyboard and screen-reader users land on what changed.
  useEffect(() => {
    if (shownFocus.current !== null && shownFocus.current !== focus.id) {
      const heading = headingRef.current;
      heading?.focus({ preventScroll: true });
      // Optional call: jsdom and very old WebViews lack scrollIntoView options.
      heading?.scrollIntoView?.({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
    }
    shownFocus.current = focus.id;
  }, [focus.id, reducedMotion]);

  const isMine = me !== null && (me.personId === focus.id || (focus.userId !== null && focus.userId === me.id));
  const generations = view.depth >= 2 ? extendedGenerations(view) : null;
  const canExpand = view.parents.length > 0 || view.children.length > 0;
  const actions =
    isMine || isAdmin ? (
      <>
        {isMine ? (
          <Button variant="secondary" size="sm" icon="✏️" onClick={() => setEditing(true)}>
            Editar mis datos
          </Button>
        ) : null}
        {isAdmin ? (
          <Button variant="ghost" size="sm" to={`/admin/familia/${encodeURIComponent(focus.id)}`}>
            Editar en administración
          </Button>
        ) : null}
      </>
    ) : null;

  return (
    <>
      <Breadcrumbs
        trail={trail}
        current={{ id: focus.id, name: focus.fullName }}
        onOpen={(entry) => onOpen({ id: entry.id, fullName: entry.name })}
      />
      {canExpand ? (
        <Button variant="ghost" size="sm" className={styles.expand} aria-expanded={expanded} onClick={onToggleExpanded}>
          {expanded ? "Ver menos" : "Ver más: abuelos y nietos"}
        </Button>
      ) : null}
      <div
        key={focus.id}
        className={cx(styles.tree, reducedMotion ? styles.reducedMotion : styles.animated)}
        data-motion={reducedMotion ? "reduced" : "full"}
        aria-busy={busy}
      >
        {expanded ? (
          generations === null ? (
            <Skeleton shape="block" height="5rem" />
          ) : (
            <RelativeBand
              title="Abuelos"
              headingId="arbol-abuelos"
              people={generations.grandparents}
              emptyText="Aún no hay abuelos registrados."
              onOpen={onOpen}
              className={styles.extendedBand}
            />
          )
        ) : null}
        <RelativeBand
          title="Padres"
          headingId="arbol-padres"
          people={view.parents}
          emptyText="Aún no hay padres registrados."
          connector="up"
          onOpen={onOpen}
        />
        <div className={styles.focusRow}>
          <FocusCard person={focus} headingRef={headingRef} actions={actions} />
          <RelativeBand
            title={view.partners.length === 1 ? "Pareja" : "Parejas"}
            headingId="arbol-parejas"
            people={view.partners}
            emptyText="Aún no hay pareja registrada."
            onOpen={onOpen}
            className={styles.partners}
          />
        </div>
        <RelativeBand
          title="Hijos"
          headingId="arbol-hijos"
          people={view.children}
          emptyText="Aún no hay hijos registrados."
          connector="down"
          onOpen={onOpen}
        />
        {expanded && generations !== null ? (
          <RelativeBand
            title="Nietos"
            headingId="arbol-nietos"
            people={generations.grandchildren}
            emptyText="Aún no hay nietos registrados."
            onOpen={onOpen}
            className={styles.extendedBand}
          />
        ) : null}
        <SiblingStrip people={view.siblings} onOpen={onOpen} headingId="arbol-hermanos" />
      </div>
      {editing ? (
        <Suspense fallback={null}>
          <SelfEditDialog person={focus} open={editing} onClose={() => setEditing(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

function TreeSkeleton(): ReactNode {
  return (
    <div className={styles.tree} aria-busy="true">
      <Skeleton shape="block" height="4.5rem" />
      <Skeleton shape="block" height="12rem" />
      <Skeleton shape="block" height="4.5rem" />
    </div>
  );
}

function NotFound(): ReactNode {
  return (
    <EmptyState
      icon="🔎"
      title="No encontramos a esa persona"
      description="Puede que la hayan quitado del árbol. Búscala por su nombre o vuelve a tu lugar en el árbol."
      action={<Button to="/arbol">Ir a mi árbol</Button>}
    />
  );
}

interface TreeErrorProps {
  error: unknown;
  hasPersonId: boolean;
  onRetry: () => void;
}

function TreeError({ error, hasPersonId, onRetry }: TreeErrorProps): ReactNode {
  const code = getApiErrorCode(error);
  // EMAIL_UNVERIFIED (WP-0.8a); FORBIDDEN kept until 0.8c centralizes this.
  if (code === "EMAIL_UNVERIFIED" || code === "FORBIDDEN") {
    return (
      <EmptyState
        tone="lock"
        icon="✉️"
        title="Verifica tu correo para ver el árbol familiar"
        description="El árbol tiene datos privados de la familia. Abre el enlace que te enviamos por correo; si no lo encuentras, pide otro desde el aviso de arriba."
      />
    );
  }
  if (code === "NOT_FOUND" || code === "VALIDATION") {
    if (hasPersonId) return <NotFound />;
    return (
      <EmptyState
        icon="🌳"
        title="Aún no estás en el árbol"
        description="Busca a un familiar arriba para empezar a recorrerlo. Un administrador puede agregarte y vincular tu cuenta."
      />
    );
  }
  return (
    <EmptyState
      icon="⚠️"
      title="No pudimos cargar el árbol"
      description="Revisa tu conexión."
      action={<Button onClick={onRetry}>Reintentar</Button>}
    />
  );
}
