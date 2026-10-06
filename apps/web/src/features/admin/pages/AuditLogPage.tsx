import type { AuditLogEntry } from "@cuencada/types";
import { type ReactNode, useId, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { IconButton } from "../../../shared/ui/IconButton";
import { Select } from "../../../shared/ui/Select";
import { TextInput } from "../../../shared/ui/TextInput";
import { PORTAL_TIME_ZONE } from "../../auth/sessionDisplay";
import styles from "../admin.module.css";
import { type AuditLogFilter, useListAuditLogsInfiniteQuery } from "../api";
import { ListFooter, Notice } from "../components/common";
import { type AuditFilterValues, readAuditFilters, toAuditQuery, writeAuditFilters } from "../lib/auditFilters";
import { formatInstant } from "../lib/format";
import { AUDIT_ACTION_OPTIONS, AUDIT_ENTITY_OPTIONS, auditActionLabel, auditEntityLabel } from "../lib/labels";
import { metadataRows } from "../lib/metadata";

/** `/admin/bitacora`: the read-only audit log, newest first, filtered through the URL. */
export function AuditLogPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const values = readAuditFilters(params);
  const query = toAuditQuery(values, PORTAL_TIME_ZONE);
  const ids = { action: useId(), type: useId(), from: useId(), to: useId() };

  const set = (patch: Partial<AuditFilterValues>): void => {
    setParams(writeAuditFilters({ ...values, ...patch }), { replace: true });
  };
  const hasFilters = Object.values(values).some((value) => value !== "");

  return (
    <>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Bitácora</h1>
      </div>
      <p className={styles.muted}>Cada cambio que hace un administrador queda registrado aquí. Nadie puede editarla ni borrarla.</p>
      <section aria-label="Filtros de la bitácora" className={styles.filters}>
        <div className={styles.filterGrid}>
          <div className={styles.panel}>
            <label htmlFor={ids.action} className={styles.navLabel}>
              Acción
            </label>
            <Select id={ids.action} value={values.action} placeholder="Todas" options={AUDIT_ACTION_OPTIONS} onChange={(e) => set({ action: e.target.value })} />
          </div>
          <div className={styles.panel}>
            <label htmlFor={ids.type} className={styles.navLabel}>
              Tipo
            </label>
            <Select id={ids.type} value={values.entityType} placeholder="Todos" options={AUDIT_ENTITY_OPTIONS} onChange={(e) => set({ entityType: e.target.value })} />
          </div>
          <div className={styles.panel}>
            <label htmlFor={ids.from} className={styles.navLabel}>
              Desde
            </label>
            <TextInput id={ids.from} type="date" value={values.from} onChange={(e) => set({ from: e.target.value })} />
          </div>
          <div className={styles.panel}>
            <label htmlFor={ids.to} className={styles.navLabel}>
              Hasta
            </label>
            <TextInput id={ids.to} type="date" value={values.to} onChange={(e) => set({ to: e.target.value })} />
          </div>
        </div>
        {values.actorUserId === "" ? null : (
          <span className={styles.chip}>
            Solo las acciones de una persona
            <IconButton label="Quitar filtro de persona" icon="✕" variant="plain" onClick={() => set({ actorUserId: "" })} />
          </span>
        )}
        {hasFilters ? (
          <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Quitar filtros
          </Button>
        ) : null}
      </section>
      <Notice message={query.ok ? null : query.error} />
      {query.ok ? <AuditList filter={query.filter} onActor={(actorUserId) => set({ actorUserId })} /> : null}
    </>
  );
}

function AuditList({ filter, onActor }: { filter: AuditLogFilter; onActor: (actorUserId: string) => void }): ReactNode {
  const list = useListAuditLogsInfiniteQuery(filter);
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  return (
    <section aria-label="Registros" className={styles.panel}>
      <ul className={styles.rows}>
        {items.map((entry) => (
          <li key={entry.id}>
            <AuditEntryCard entry={entry} onActor={onActor} />
          </li>
        ))}
      </ul>
      <ListFooter
        isLoading={list.isLoading}
        isError={list.isError}
        isEmpty={items.length === 0}
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        emptyTitle="No hay registros con estos filtros"
        errorTitle="No pudimos cargar la bitácora"
        onRetry={() => void list.refetch()}
        onMore={() => void list.fetchNextPage()}
      />
    </section>
  );
}

/** Who did it: the actor's current name, "Cuenta eliminada" when gone, "Sistema" for system rows. */
function actorLabel(entry: AuditLogEntry): string {
  if (entry.actorName !== null) return entry.actorName;
  return entry.actorUserId === null ? "Sistema" : "Cuenta eliminada";
}

function AuditEntryCard({ entry, onActor }: { entry: AuditLogEntry; onActor: (actorUserId: string) => void }): ReactNode {
  const rows = metadataRows(entry.metadata);
  const actorId = entry.actorUserId;
  return (
    <Card as="article" padding="sm" className={styles.item}>
      <h2 className={styles.itemTitle}>
        {actorId === null ? (
          actorLabel(entry)
        ) : (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => onActor(actorId)}
            aria-label={`${actorLabel(entry)}: ver solo sus acciones`}
          >
            {actorLabel(entry)}
          </button>
        )}{" "}
        · {auditActionLabel(entry.action)}
      </h2>
      <p className={styles.entryMeta}>
        <time dateTime={entry.createdAt}>{formatInstant(entry.createdAt)}</time>
        <span>
          {auditEntityLabel(entry.entityType)}
          {entry.entityId === null ? null : <span className={styles.mono}> {entry.entityId}</span>}
        </span>
        <span className={styles.mono}>{entry.action}</span>
        {entry.ip === null ? null : <span>IP {entry.ip}</span>}
      </p>
      {rows.length === 0 ? null : (
        <dl className={styles.metadata} aria-label="Detalles">
          {rows.map((row) => (
            <div key={row.key} className={styles.metaRow}>
              <dt>{row.key}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}
