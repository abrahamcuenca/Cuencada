import { type ReactNode, useEffect, useState } from "react";
import { useStore } from "react-redux";
import type { AppStore } from "../../app/store";
import { reportUnexpected } from "../../shared/lib/reportUnexpected";
import { Button } from "../../shared/ui/Button";
import { selectIsOffline } from "../auth/authSlice";
import { useAppSelector } from "../../app/hooks";
import styles from "./pwa.module.css";
import { usePwaState } from "./pwaState";
import { startPwa } from "./startPwa";

/** Update banner, first step. */
export const UPDATE_AVAILABLE_TEXT = "Hay una versión nueva";
/** Update banner, confirmation step (a reload would abort an upload in progress). */
export const UPDATE_CONFIRM_TEXT = "¿Recargar ahora? Si estás subiendo fotos, espera a que terminen.";
/** Public programa answered from the service worker cache while offline. */
export const OFFLINE_CACHED_TEXT = "Sin conexión — mostrando la última versión guardada";
/** Same, while online but the network timed out. */
export const SLOW_CACHED_TEXT = "Conexión lenta — mostrando la última versión guardada";

type UpdateStep = "available" | "confirm" | "applying" | "later";

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

function UpdateBanner({ applyUpdate }: { applyUpdate: () => Promise<void> }): ReactNode {
  const [step, setStep] = useState<UpdateStep>("available");
  if (step === "later") return null;

  const apply = (): void => {
    setStep("applying");
    applyUpdate().catch((error: unknown) => {
      reportUnexpected(error);
      setStep("confirm");
    });
  };

  return (
    <section className={styles.bar} aria-label="Actualización disponible">
      <output className={styles.text}>{step === "available" ? UPDATE_AVAILABLE_TEXT : UPDATE_CONFIRM_TEXT}</output>
      <div className={styles.actions}>
        {step === "available" ? (
          <>
            <Button size="sm" onClick={() => setStep("confirm")}>
              Actualizar
            </Button>
            <Button size="sm" variant="ghost" className={styles.ghost} onClick={() => setStep("later")}>
              Más tarde
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" loading={step === "applying"} onClick={apply}>
              Recargar ahora
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={styles.ghost}
              disabled={step === "applying"}
              onClick={() => setStep("available")}
            >
              Cancelar
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * PWA status, mounted once in the app layout: starts the service worker
 * runtime, shows the "new version" prompt and the "showing the saved
 * programa" notice. Both sit above the bottom nav and never block the page.
 */
export function PwaStatus(): ReactNode {
  const store = useStore.withTypes<AppStore>()();
  const { applyUpdate, publicApiSource } = usePwaState();
  const isOffline = useAppSelector(selectIsOffline);
  const online = useOnline();

  useEffect(() => startPwa(store), [store]);

  const servedFromCache = publicApiSource === "cache";
  if (applyUpdate === null && !servedFromCache) return null;

  return (
    <div className={styles.stack}>
      {servedFromCache ? (
        <output className={styles.notice}>{isOffline || !online ? OFFLINE_CACHED_TEXT : SLOW_CACHED_TEXT}</output>
      ) : null}
      {applyUpdate === null ? null : <UpdateBanner applyUpdate={applyUpdate} />}
    </div>
  );
}
