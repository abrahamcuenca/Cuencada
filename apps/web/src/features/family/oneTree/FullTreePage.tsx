import type { TreeOverview, TreeOverviewNode } from "@cuencada/types";
import { type ReactNode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useToast } from "../../../shared/ui/Toast";
import { cx } from "../../../shared/ui/cx";
import { useAccessDenial } from "../../auth/accessDenied";
import { selectCurrentUser, selectIsAdmin } from "../../auth/authSlice";
import { AccessDeniedState } from "../../auth/components/AccessDeniedState";
import { PersonSearch } from "../components/PersonSearch";
import { useGetTreeOverviewQuery, useLazyGetTreeOverviewPathQuery, useLazyGetTreeOverviewQuery } from "./api";
import { ConnectCta } from "./ConnectCta";
import { childrenText, nodeYears, partnersText } from "./labels";
import styles from "./oneTree.module.css";

const ProposeDialog = lazy(async () => ({ default: (await import("./ProposeDialog")).ProposeDialog }));

/** The outline loaded so far: nodes by id and each parent's children, in display order. */
export interface Outline {
  nodes: ReadonlyMap<string, TreeOverviewNode>;
  children: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_OUTLINE: Outline = { nodes: new Map(), children: new Map() };

/**
 * Merge one overview response into the outline (pure). A sub-tree loaded
 * from a person keeps that person's place (its `parentId` from before).
 */
export function mergeOutline(outline: Outline, overview: Pick<TreeOverview, "nodes">): Outline {
  const nodes = new Map(outline.nodes);
  const children = new Map(outline.children);
  const groups = new Map<string, string[]>();
  for (const node of overview.nodes) {
    const previous = nodes.get(node.id);
    nodes.set(node.id, node.parentId === null && previous !== undefined ? { ...node, parentId: previous.parentId } : node);
    if (node.parentId !== null) {
      const group = groups.get(node.parentId);
      if (group === undefined) groups.set(node.parentId, [node.id]);
      else group.push(node.id);
    }
  }
  for (const [parentId, ids] of groups) children.set(parentId, ids);
  return { nodes, children };
}

/** True when `id`'s children still have to be fetched before showing them. */
function needsChildren(outline: Outline, id: string): boolean {
  const node = outline.nodes.get(id);
  return node !== undefined && node.childrenCount > 0 && (node.hasMore || !outline.children.has(id));
}

/**
 * `/arbol/completo` ("Árbol completo", WP-6.4): the descendants of the root
 * ancestor as a collapsible outline, loaded one generation at a time.
 * Names only (the server sends no photos or account ids; living people's
 * years only where the viewer may see them). Search or "Ir a mí" opens the
 * path from the root down to that person.
 */
export function FullTreePage(): ReactNode {
  const me = useAppSelector(selectCurrentUser);
  const isAdmin = useAppSelector(selectIsAdmin);
  const first = useGetTreeOverviewQuery({ depth: 2 });
  const [loadMore] = useLazyGetTreeOverviewQuery();
  const [loadPath] = useLazyGetTreeOverviewPathQuery();
  const [outline, setOutline] = useState<Outline>(EMPTY_OUTLINE);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);
  const toast = useToast();
  const denial = useAccessDenial(first.error);
  const data = first.currentData;

  useEffect(() => {
    if (data === undefined) return;
    setOutline((current) => mergeOutline(current, data));
    if (data.rootId !== null) setExpanded((current) => new Set([...current, data.rootId ?? ""]));
  }, [data]);

  useEffect(() => {
    if (highlight === null) return;
    const element = document.getElementById(`nodo-${highlight}`);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView?.({ block: "center" });
  }, [highlight]);

  /** Fetch `id`'s children when needed; returns the outline after the merge. */
  const ensureChildren = useCallback(
    async (current: Outline, id: string): Promise<Outline> => {
      if (!needsChildren(current, id)) return current;
      setLoading((set) => new Set([...set, id]));
      try {
        const slice = await loadMore({ personId: id, depth: 1 }, true).unwrap();
        const next = mergeOutline(current, slice);
        setOutline((latest) => mergeOutline(latest, slice));
        return next;
      } finally {
        setLoading((set) => new Set([...set].filter((item) => item !== id)));
      }
    },
    [loadMore]
  );

  const toggle = async (id: string): Promise<void> => {
    if (expanded.has(id)) {
      setExpanded(new Set([...expanded].filter((item) => item !== id)));
      return;
    }
    try {
      await ensureChildren(outline, id);
      setExpanded((current) => new Set([...current, id]));
    } catch (error) {
      if (!isAbortError(error)) toast.show({ message: getApiErrorMessage(error), tone: "danger" });
    }
  };

  const goTo = async (personId: string): Promise<void> => {
    try {
      const { ids } = await loadPath(personId, true).unwrap();
      if (ids.length === 0) {
        toast.show({ message: "Esa persona todavía no está unida a la raíz del árbol.", tone: "info" });
        return;
      }
      let current = outline;
      for (const id of ids.slice(0, -1)) current = await ensureChildren(current, id);
      setExpanded((set) => new Set([...set, ...ids.slice(0, -1)]));
      setHighlight(personId);
    } catch (error) {
      if (!isAbortError(error)) toast.show({ message: getApiErrorMessage(error), tone: "danger" });
    }
  };

  let body: ReactNode;
  if (data === undefined) {
    if (denial !== null) {
      body = <AccessDeniedState denial={denial} verifyTitle="Verifica tu correo para ver el árbol familiar" forbiddenTitle="No tienes acceso al árbol familiar" />;
    } else if (first.isError) {
      body = <EmptyState icon="⚠️" title="No pudimos cargar el árbol completo" action={<Button onClick={() => void first.refetch()}>Reintentar</Button>} />;
    } else {
      body = <Skeleton shape="block" height="16rem" />;
    }
  } else if (data.rootId === null) {
    body = (
      <EmptyState
        icon="🌳"
        title="Aún no hay una raíz del árbol"
        description="Cuando un administrador elija al ancestro más antiguo, aquí verás a todos sus descendientes."
        {...(isAdmin ? { action: <Button to="/admin/familia/ramas">Elegir la raíz</Button> } : {})}
      />
    );
  } else {
    body = (
      <>
        <div className={styles.toolbar}>
          <PersonSearch label="Buscar en el árbol completo" actionLabel="Mostrar a" onPick={(person) => void goTo(person.id)} />
          {me?.personId ? (
            <Button variant="secondary" onClick={() => void goTo(me.personId ?? "")}>
              Ir a mí
            </Button>
          ) : null}
        </div>
        <ul className={styles.outline} aria-label="Descendientes de la raíz">
          <OutlineNode id={data.rootId} outline={outline} expanded={expanded} loading={loading} highlight={highlight} onToggle={(id) => void toggle(id)} />
        </ul>
      </>
    );
  }

  return (
    <div className={cx("cu-container", styles.page)}>
      <Link to="/arbol" className={styles.back}>
        ‹ Árbol familiar
      </Link>
      <h1 className={styles.pageTitle}>Árbol completo</h1>
      <p className={styles.muted}>Todos los descendientes de la raíz del árbol. Toca ▸ para ver la siguiente generación.</p>
      {me?.personId ? <ConnectCta onPropose={() => setProposing(true)} /> : null}
      {body}
      {proposing && me?.personId ? (
        <Suspense fallback={null}>
          <ProposeDialog focus={{ id: me.personId, fullName: me.displayName }} mode="relate" onClose={() => setProposing(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

interface OutlineNodeProps {
  id: string;
  outline: Outline;
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  highlight: string | null;
  onToggle: (id: string) => void;
}

function OutlineNode({ id, outline, expanded, loading, highlight, onToggle }: OutlineNodeProps): ReactNode {
  const node = outline.nodes.get(id);
  if (node === undefined) return null;
  const open = expanded.has(id) && !loading.has(id);
  const kids = outline.children.get(id) ?? [];
  const meta = [nodeYears(node), partnersText(node), childrenText(node.childrenCount)].filter((part) => part !== null).join(" · ");
  const name = node.nickname ? `${node.name} «${node.nickname}»` : node.name;
  return (
    <li>
      <div className={cx(styles.node, highlight === id && styles.highlight)}>
        <button
          type="button"
          className={styles.toggle}
          disabled={node.childrenCount === 0}
          aria-expanded={node.childrenCount === 0 ? undefined : open}
          aria-controls={node.childrenCount === 0 ? undefined : `hijos-${id}`}
          aria-label={node.childrenCount === 0 ? `${node.name} no tiene hijos registrados` : `${open ? "Ocultar" : "Mostrar"} hijos de ${node.name}`}
          aria-busy={loading.has(id) || undefined}
          onClick={() => onToggle(id)}
        >
          {node.childrenCount === 0 ? "·" : open ? "▾" : "▸"}
        </button>
        <div className={styles.nodeBody}>
          <Link id={`nodo-${id}`} to={`/arbol/${encodeURIComponent(id)}`} className={styles.nodeLink}>
            {name}
            {node.deceased ? " †" : ""}
          </Link>
          {meta !== "" ? <span className={styles.nodeMeta}>{meta}</span> : null}
        </div>
      </div>
      {open && kids.length > 0 ? (
        <ul id={`hijos-${id}`} className={styles.outline}>
          {kids.map((child) => (
            <OutlineNode key={child} id={child} outline={outline} expanded={expanded} loading={loading} highlight={highlight} onToggle={onToggle} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
