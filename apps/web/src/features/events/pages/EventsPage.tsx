/**
 * `/eventos` (members, WP-5.4): the family's events beyond the Cuencada.
 * "Próximos" / "Pasados" tabs, a year filter and "Mis eventos", in the URL
 * (`?cuando=pasados&anio=2025&mios=1`) so back and reload keep them. Keyset
 * paged with "Cargar más". "＋ Crear evento" opens the create sheet.
 */
import type { EventListWhen } from "@cuencada/types";
import { type ReactNode, useId, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Switch } from "../../../shared/ui/Checkbox";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Select } from "../../../shared/ui/Select";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { Tabs } from "../../../shared/ui/Tabs";
import { cx } from "../../../shared/ui/cx";
import { useAccessDenial } from "../../auth/accessDenied";
import { AccessDeniedState } from "../../auth/components/AccessDeniedState";
import { type EventListFilter, useListEventsInfiniteQuery } from "../api";
import { EventCard } from "../components/EventCard";
import { EventFormSheet } from "../components/EventFormSheet";
import { EventNotices } from "../notices/AddedToEventNotice";
import styles from "../events.module.css";
import { currentEventYear } from "../lib/form";

/** Oldest year offered in the filter. */
const FIRST_FILTER_YEAR = 2015;

/** Years for the filter, newest first: next year down to {@link FIRST_FILTER_YEAR}. */
export function filterYears(now: Date = new Date()): number[] {
  const newest = currentEventYear(now) + 1;
  return Array.from({ length: newest - FIRST_FILTER_YEAR + 1 }, (_, index) => newest - index);
}

/**
 * Reads the filters from the URL; anything unexpected falls back to the default.
 *
 * @param search - The page's search params.
 */
export function filterFromSearch(search: URLSearchParams): EventListFilter {
  const when: EventListWhen = search.get("cuando") === "pasados" ? "past" : "upcoming";
  const yearText = search.get("anio");
  const year = yearText !== null && /^\d{4}$/.test(yearText) ? Number(yearText) : undefined;
  const mine = search.get("mios") === "1";
  return { when, ...(year === undefined ? {} : { year }), ...(mine ? { mine: true } : {}) };
}

/** The list page. */
export function EventsPage(): ReactNode {
  const [search, setSearch] = useSearchParams();
  const filter = filterFromSearch(search);
  const [creating, setCreating] = useState(false);
  const yearId = useId();

  const update = (change: (params: URLSearchParams) => void): void => {
    const params = new URLSearchParams(search);
    change(params);
    setSearch(params, { replace: true });
  };

  const list = <EventList filter={filter} onCreate={() => setCreating(true)} />;

  return (
    <div className={cx("cu-container", styles.page)}>
      <header className={styles.listHeader}>
        <div>
          <h1 className={styles.title}>Eventos</h1>
          <p className={styles.intro}>Paseos, comidas y reuniones de la familia, además de la Cuencada.</p>
        </div>
        <Button icon="＋" onClick={() => setCreating(true)}>
          Crear evento
        </Button>
      </header>
      <EventNotices />
      <div className={styles.filters}>
        <div className={styles.yearFilter}>
          <label htmlFor={yearId} className={styles.albumLabel}>
            Año
          </label>
          <Select
            id={yearId}
            value={filter.year === undefined ? "" : String(filter.year)}
            options={[{ value: "", label: "Todos los años" }, ...filterYears().map((year) => ({ value: String(year), label: String(year) }))]}
            onChange={(e) =>
              update((params) => {
                if (e.target.value === "") params.delete("anio");
                else params.set("anio", e.target.value);
              })
            }
          />
        </div>
        <Switch
          label="Mis eventos"
          checked={filter.mine === true}
          onChange={(e) =>
            update((params) => {
              if (e.target.checked) params.set("mios", "1");
              else params.delete("mios");
            })
          }
        />
      </div>
      <Tabs
        label="Cuándo"
        value={filter.when}
        onChange={(next) =>
          update((params) => {
            if (next === "past") params.set("cuando", "pasados");
            else params.delete("cuando");
          })
        }
        items={[
          { id: "upcoming", label: "Próximos", content: filter.when === "upcoming" ? list : null },
          { id: "past", label: "Pasados", content: filter.when === "past" ? list : null }
        ]}
      />
      {creating ? <EventFormSheet open onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function emptyCopy(filter: EventListFilter): { title: string; description: string } {
  if (filter.mine === true) return { title: "Todavía no participas en ningún evento", description: "Apúntate a uno o crea el tuyo." };
  if (filter.when === "past") return { title: "No hay eventos pasados", description: filter.year === undefined ? "Aquí quedarán los eventos que ya ocurrieron." : "Prueba con otro año." };
  return { title: "Aún no hay eventos próximos", description: "¿Organizas algo? Crea un evento e invita a la familia." };
}

function EventList({ filter, onCreate }: { filter: EventListFilter; onCreate: () => void }): ReactNode {
  const { data, isLoading, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useListEventsInfiniteQuery(filter);
  const denial = useAccessDenial(error);
  const events = data?.pages.flatMap((page) => page.items) ?? [];

  if (isLoading) {
    return (
      <div className={styles.grid} aria-busy="true">
        <span className="visually-hidden">Cargando eventos…</span>
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} shape="block" height="16rem" />
        ))}
      </div>
    );
  }
  if (isError && data === undefined) {
    if (isAbortError(error)) return null;
    if (denial !== null) return <AccessDeniedState denial={denial} verifyTitle="Verifica tu correo para ver los eventos" forbiddenTitle="No tienes acceso a los eventos" />;
    return (
      <EmptyState
        icon="📡"
        title="No pudimos cargar los eventos"
        description="Revisa tu conexión e inténtalo de nuevo."
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Reintentar
          </Button>
        }
      />
    );
  }
  if (events.length === 0) {
    const copy = emptyCopy(filter);
    return (
      <EmptyState
        icon="🎉"
        title={copy.title}
        description={copy.description}
        action={
          <Button icon="＋" onClick={onCreate}>
            Crear evento
          </Button>
        }
      />
    );
  }
  return (
    <>
      <ul className={styles.grid} aria-label={filter.when === "past" ? "Eventos pasados" : "Eventos próximos"}>
        {events.map((event) => (
          <li key={event.id}>
            <EventCard event={event} onMediaError={() => void refetch()} />
          </li>
        ))}
      </ul>
      {hasNextPage ? (
        <div className={styles.more}>
          <Button variant="secondary" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            Cargar más
          </Button>
        </div>
      ) : null}
    </>
  );
}
