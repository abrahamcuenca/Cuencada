import { type AdminUserListItem, userRoleSchema, userStatusSchema } from "@cuencada/types";
import { type ReactNode, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { Badge } from "../../../shared/ui/Badge";
import { Select } from "../../../shared/ui/Select";
import { TextInput } from "../../../shared/ui/TextInput";
import { selectCurrentUser } from "../../auth/authSlice";
import styles from "../admin.module.css";
import { type UserListFilter, useListAdminUsersInfiniteQuery } from "../api";
import { ListFooter } from "../components/common";
import { UserSheet } from "../components/UserSheet";
import { useDebouncedValue } from "../lib/hooks";
import { ROLE_LABEL } from "../lib/labels";

const ROLE_OPTIONS = [
  { value: "", label: "Todos" },
  { value: "member", label: "Miembros" },
  { value: "admin", label: "Administradores" }
];

/** `?correo=` values of the email filter. */
export const EMAIL_FILTER = { Unverified: "sin-verificar", Verified: "verificado" } as const;

const EMAIL_OPTIONS = [
  { value: "", label: "Todos" },
  { value: EMAIL_FILTER.Unverified, label: "Sin verificar" },
  { value: EMAIL_FILTER.Verified, label: "Verificado" }
];

/** `?correo=` → the API's `emailVerified`, or `undefined` for any other value. */
function emailVerifiedFrom(value: string | null): boolean | undefined {
  if (value === EMAIL_FILTER.Unverified) return false;
  if (value === EMAIL_FILTER.Verified) return true;
  return undefined;
}

const STATUS_OPTIONS = [
  { value: "", label: "Todas" },
  { value: "active", label: "Activas" },
  { value: "disabled", label: "Deshabilitadas" }
];

/** `/admin/usuarios`: search, filter and manage accounts. `?rol=` and `?estado=` are kept in the URL. */
export function UsersPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const role = userRoleSchema.safeParse(params.get("rol"));
  const status = userStatusSchema.safeParse(params.get("estado"));
  const emailVerified = emailVerifiedFrom(params.get("correo"));
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim());
  const filter = useMemo<UserListFilter>(
    () => ({
      ...(q === "" ? {} : { q }),
      ...(role.success ? { role: role.data } : {}),
      ...(status.success ? { status: status.data } : {}),
      ...(emailVerified === undefined ? {} : { emailVerified })
    }),
    [q, role.success, role.data, status.success, status.data, emailVerified]
  );
  const ids = { search: useId(), role: useId(), status: useId(), email: useId() };

  const setParam = (name: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  };

  return (
    <>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Usuarios</h1>
      </div>
      <section aria-label="Lista de usuarios" className={styles.panel}>
        <div className={styles.filters}>
          <div className={styles.panel}>
            <label htmlFor={ids.search} className={styles.navLabel}>
              Buscar por nombre o correo
            </label>
            <TextInput
              id={ids.search}
              type="search"
              value={text}
              maxLength={100}
              autoComplete="off"
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <div className={styles.filterGrid}>
            <div className={styles.panel}>
              <label htmlFor={ids.role} className={styles.navLabel}>
                Rol
              </label>
              <Select id={ids.role} value={role.success ? role.data : ""} options={ROLE_OPTIONS} onChange={(event) => setParam("rol", event.target.value)} />
            </div>
            <div className={styles.panel}>
              <label htmlFor={ids.status} className={styles.navLabel}>
                Estado
              </label>
              <Select
                id={ids.status}
                value={status.success ? status.data : ""}
                options={STATUS_OPTIONS}
                onChange={(event) => setParam("estado", event.target.value)}
              />
            </div>
            <div className={styles.panel}>
              <label htmlFor={ids.email} className={styles.navLabel}>
                Correo
              </label>
              <Select
                id={ids.email}
                value={emailVerified === undefined ? "" : emailVerified ? EMAIL_FILTER.Verified : EMAIL_FILTER.Unverified}
                options={EMAIL_OPTIONS}
                onChange={(event) => setParam("correo", event.target.value)}
              />
            </div>
          </div>
        </div>
        <UserList filter={filter} />
      </section>
    </>
  );
}

function UserList({ filter }: { filter: UserListFilter }): ReactNode {
  const list = useListAdminUsersInfiniteQuery(filter);
  // TODO(WP-0.8b merged): drop the client-side check. A server without the `emailVerified`
  // filter ignores the parameter (the query schema strips unknown keys), so rows are also
  // filtered here to keep the list right either way.
  const items = useMemo(() => {
    const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
    return filter.emailVerified === undefined ? rows : rows.filter((user) => user.emailVerified === filter.emailVerified);
  }, [list.data, filter.emailVerified]);
  const me = useAppSelector(selectCurrentUser);
  const [selected, setSelected] = useState<AdminUserListItem | null>(null);

  return (
    <>
      <ul className={styles.rows}>
        {items.map((user) => (
          <li key={user.id}>
            <UserRow user={user} isSelf={user.id === me?.id} onOpen={() => setSelected(user)} />
          </li>
        ))}
      </ul>
      <ListFooter
        isLoading={list.isLoading}
        isError={list.isError}
        isEmpty={items.length === 0}
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        emptyTitle="No encontramos cuentas"
        emptyDescription="Prueba con otro nombre, correo o filtro."
        errorTitle="No pudimos cargar las cuentas"
        onRetry={() => void list.refetch()}
        onMore={() => void list.fetchNextPage()}
      />
      {selected === null ? null : (
        <UserSheet user={selected} isSelf={selected.id === me?.id} onClose={() => setSelected(null)} onUpdated={setSelected} />
      )}
    </>
  );
}

interface UserRowProps {
  user: AdminUserListItem;
  isSelf: boolean;
  onOpen: () => void;
}

function UserRow({ user, isSelf, onOpen }: UserRowProps): ReactNode {
  return (
    <button type="button" className={styles.rowButton} onClick={onOpen} aria-haspopup="dialog">
      <AvatarCircle name={user.displayName} size="sm" decorative />
      <span className={styles.rowMain}>
        <span className={styles.itemTitle}>
          {user.displayName}
          {isSelf ? " (tú)" : ""}
        </span>
        <span className={styles.muted}>{user.email}</span>
        <span className={styles.badges}>
          {user.role === "admin" ? <Badge tone="festive">{ROLE_LABEL.admin}</Badge> : null}
          {user.status === "disabled" ? <Badge tone="danger">Deshabilitada</Badge> : null}
          {user.emailVerified ? null : <Badge tone="accent">Sin verificar</Badge>}
          {user.mustChangePassword ? <Badge tone="accent">Cambio de contraseña</Badge> : null}
        </span>
      </span>
      <span aria-hidden="true" className={styles.chevron}>
        ›
      </span>
    </button>
  );
}
