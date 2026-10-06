import { type ReactNode, useState } from "react";
import { reportUnexpected } from "../../shared/lib/reportUnexpected";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import { dismissInstall, isInstallDismissed, isIosDevice, isStandalone } from "./install";
import styles from "./pwa.module.css";
import { updatePwaState, usePwaState } from "./pwaState";

/** iOS has no install prompt: Safari's Share sheet does it. */
export const IOS_INSTALL_HINT = "En iPhone o iPad: toca Compartir y luego “Agregar a inicio”.";

/**
 * Optional "Instalar app" card for the "Más" page. Android/Chromium: a
 * button that opens the deferred `beforeinstallprompt`. iOS: the Share →
 * "Agregar a inicio" hint. Hidden once installed, when the browser offers
 * neither, or after the user closes it (remembered in localStorage).
 */
export function InstallAppCard(): ReactNode {
  const { installPrompt } = usePwaState();
  const [dismissed, setDismissed] = useState(isInstallDismissed);
  const [ios] = useState(() => isIosDevice());

  if (dismissed || isStandalone() || (installPrompt === null && !ios)) return null;

  const close = (): void => {
    dismissInstall();
    setDismissed(true);
  };

  const install = async (): Promise<void> => {
    if (installPrompt === null) return;
    // A prompt can only be shown once; forget it either way.
    updatePwaState({ installPrompt: null });
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "dismissed") close();
  };

  return (
    <section className={styles.install} aria-labelledby="pwa-install-title">
      <h2 id="pwa-install-title" className={styles.installTitle}>
        Instalar app
      </h2>
      <p className={styles.installText}>Abre Cuencada desde tu pantalla de inicio y consulta el programa aunque no tengas señal.</p>
      {installPrompt === null ? (
        <p className={styles.installText}>{IOS_INSTALL_HINT}</p>
      ) : (
        <Button
          size="sm"
          className={styles.installAction}
          onClick={() => {
            install().catch(reportUnexpected);
          }}
        >
          Instalar
        </Button>
      )}
      <IconButton label="Ocultar la sugerencia de instalar" icon="✕" variant="plain" className={styles.installClose} onClick={close} />
    </section>
  );
}
