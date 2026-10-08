import { type FamilyTreeView, idSchema } from "@cuencada/types";
import { type ReactNode, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { getApiErrorCode, getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useToast } from "../../../shared/ui/Toast";
import { cx } from "../../../shared/ui/cx";
import { useAccessDenial } from "../../auth/accessDenied";
import { selectCurrentUser, selectIsAdmin } from "../../auth/authSlice";
import { AccessDeniedState } from "../../auth/components/AccessDeniedState";
import { ConfirmDialog } from "../admin/components/ConfirmDialog";
import { useDeleteFamilyPersonMutation, useGetFamilyTreeQuery, useGetPersonQuery } from "../api";
import { ADD_RELATIVE_LABELS, type RelativeRole } from "../components/addRelative";
import { PersonDetailsSection } from "../components/PersonDetailsSection";
import { PersonSearch } from "../components/PersonSearch";
import { Breadcrumbs, FocusCard, type OpenPerson, RelativeBand, SiblingStrip } from "../components/TreeParts";
import styles from "../family.module.css";
import { useCachedPersonNames, usePrefersReducedMotion } from "../lib/hooks";
import { type TrailEntry, type TreeLocationState, extendedGenerations, nextTrail, readTrail, resolveTrail } from "../lib/tree";
import { PersonPhotoEditor } from "../photo";
import { InvitePersonButton } from "../../admin/components/InvitePersonButton";

// The sheets download only when opened.
const EditPersonDialog = lazy(async () => ({
  default: (await import("../components/EditPersonDialog")).EditPersonDialog
}));
const AddRelativeDialog = lazy(async () => ({
  default: (await import("../components/AddRelativeDialog")).AddRelativeDialog
}));

/** Depth of the expanded view: up to great-great-grandparents (WP-4.1). */
const EXPANDED_DEPTH = 4;
/** A person has at most two recorded parents (the server enforces it too). */
const MAX_PARENTS = 2;

/**
 * `/arbol/:personId?` (members): a person-centred family tree. Parents
 * above, partners beside (below on phones), children below, siblings in a
 * scrolling strip; tapping anyone navigates to them, so the URL, Back and
 * the breadcrumb trail all follow. "Ver más" loads up to four generations.
 * Without `personId` the caller's own node is the focus. People who may
 * edit get "Agregar …" on the bands and "Editar"/"Eliminar" on the card.
 */
export function FamilyTreePage(): ReactNode {
  const { personId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const trailIds = useMemo(() => readTrail(location.state), [location.state]);
  const names = useCachedPersonNames();
  const trail = useMemo(() => resolveTrail(trailIds, names), [trailIds, names]);
  const [expanded, setExpanded] = useState(false);
  const validId = personId === undefined || idSchema.safeParse(personId).success;

  const depth = expanded ? EXPANDED_DEPTH : 1;
  const tree = useGetFamilyTreeQuery(personId === undefined ? { depth } : { personId, depth }, {
    skip: !validId
  });

  const open: OpenPerson = (person) => {
    const currentId = tree.data?.focus.id ?? null;
    if (person.id === currentId) return;
    // [SEC] ids only in history state; names are resolved from memory when rendering.
    const state: TreeLocationState = {
      trail: nextTrail(trailIds, currentId, person.id)
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
  const [adding, setAdding] = useState<RelativeRole | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownFocus = useRef<string | null>(null);
  const { focus } = view;
  const cached = useGetPersonQuery(focus.id).currentData;
  const details = cached?.id === focus.id ? cached : undefined;
  const [remove, removeState] = useDeleteFamilyPersonMutation();
  const navigate = useNavigate();
  const toast = useToast();
  // WP-4.3: `PersonDetails.canEditPhoto` decides whether the tree-photo controls show (in "Detalles").
  const photoEditor = details?.canEditPhoto === true ? <PersonPhotoEditor person={details} /> : null;

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
  // UX only: the server re-checks every write (own-family circle, ADR 0001 §6).
  const canEdit = details?.canEdit === true;
  const canAdd = isAdmin || details?.canAddRelative === true;
  const canDelete = details?.canDelete === true;
  const relatedIds = new Set([focus.id, ...[...view.parents, ...view.partners, ...view.children].map((person) => person.id)]);

  const addButton = (role: RelativeRole): ReactNode =>
    canAdd && !(role === "parent" && view.parents.length >= MAX_PARENTS) ? (
      <Button variant="ghost" size="sm" icon="+" onClick={() => setAdding(role)}>
        {ADD_RELATIVE_LABELS[role]}
      </Button>
    ) : null;

  const doDelete = async (): Promise<void> => {
    try {
      await remove(focus.id).unwrap();
      toast.show({ message: `Quitamos a ${focus.fullName} del árbol.`, tone: "success" });
      setConfirmDelete(false);
      navigate("/arbol");
    } catch (error) {
      setConfirmDelete(false);
      if (isAbortError(error)) return;
      toast.show({ message: getApiErrorMessage(error), tone: "danger" });
    }
  };

  const actions =
    canEdit || canDelete || isAdmin ? (
      <>
        {canEdit ? (
          <Button variant="secondary" size="sm" icon="✏️" onClick={() => setEditing(true)}>
            {isMine ? "Editar mis datos" : "Editar"}
          </Button>
        ) : null}
        {canDelete ? (
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
            Eliminar
          </Button>
        ) : null}
        {isAdmin ? (
          <Button variant="ghost" size="sm" to={`/admin/familia/${encodeURIComponent(focus.id)}`}>
            Editar en administración
          </Button>
        ) : null}
        {isAdmin ? <InvitePersonButton personId={focus.id} /> : null}
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
        {expanded && generations !== null && generations.greatGreatGrandparents.length > 0 ? (
          <RelativeBand
            title="Tatarabuelos"
            headingId="arbol-tatarabuelos"
            people={generations.greatGreatGrandparents}
            emptyText=""
            onOpen={onOpen}
            className={styles.extendedBand}
          />
        ) : null}
        {expanded && generations !== null && generations.greatGrandparents.length > 0 ? (
          <RelativeBand
            title="Bisabuelos"
            headingId="arbol-bisabuelos"
            people={generations.greatGrandparents}
            emptyText=""
            onOpen={onOpen}
            className={styles.extendedBand}
          />
        ) : null}
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
          action={addButton("parent")}
        />
        <div className={styles.focusRow}>
          <FocusCard
            person={focus}
            headingRef={headingRef}
            actions={actions}
            details={details === undefined ? null : <PersonDetailsSection person={details} photoEditor={photoEditor} />}
          />
          <RelativeBand
            title={view.partners.length === 1 ? "Pareja" : "Parejas"}
            headingId="arbol-parejas"
            people={view.partners}
            emptyText="Aún no hay pareja registrada."
            onOpen={onOpen}
            className={styles.partners}
            action={addButton("partner")}
          />
        </div>
        <RelativeBand
          title="Hijos"
          headingId="arbol-hijos"
          people={view.children}
          emptyText="Aún no hay hijos registrados."
          connector="down"
          onOpen={onOpen}
          action={addButton("child")}
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
      {editing && details !== undefined ? (
        <Suspense fallback={null}>
          <EditPersonDialog
            person={details}
            open={editing}
            isAdmin={isAdmin}
            {...(isMine ? { title: "Editar mis datos" } : {})}
            onClose={() => setEditing(false)}
          />
        </Suspense>
      ) : null}
      {adding !== null ? (
        <Suspense fallback={null}>
          <AddRelativeDialog
            anchor={{ id: focus.id, fullName: focus.fullName }}
            role={adding}
            isAdmin={isAdmin}
            relatedIds={relatedIds}
            onClose={() => setAdding(null)}
          />
        </Suspense>
      ) : null}
      {canDelete ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`¿Quitar a ${focus.fullName} del árbol?`}
          description="Se quitan también las relaciones que agregaste con esta persona."
          confirmLabel="Eliminar"
          busy={removeState.isLoading}
          onConfirm={() => void doDelete()}
          onClose={() => setConfirmDelete(false)}
        />
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
  const denial = useAccessDenial(error);
  if (denial !== null) {
    return (
      <AccessDeniedState
        denial={denial}
        verifyTitle="Verifica tu correo para ver el árbol familiar"
        forbiddenTitle="No tienes acceso al árbol familiar"
        verifyDescription="El árbol tiene datos privados de la familia. Abre el enlace que te enviamos por correo; si no lo encuentras, pide otro."
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
