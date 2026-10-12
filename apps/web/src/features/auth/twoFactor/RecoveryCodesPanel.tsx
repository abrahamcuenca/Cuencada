import { type ReactNode, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import styles from "./twoFactor.module.css";

/** File name of the downloaded codes. */
export const RECOVERY_CODES_FILE = "cuencada-codigos-de-recuperacion.txt";

/**
 * The text file with the codes (Spanish instructions, one code per line).
 *
 * @param codes - Formatted codes.
 */
export function recoveryCodesText(codes: readonly string[]): string {
  return [
    "Cuencada: códigos de recuperación de la verificación en dos pasos",
    "",
    "Cada código sirve una sola vez para entrar si no tienes tu teléfono.",
    "Guárdalos en un lugar seguro y no los compartas con nadie.",
    "",
    ...codes,
    ""
  ].join("\n");
}

/**
 * Save the codes as a `.txt` through a Blob URL (no data leaves the browser;
 * the CSP needs nothing new). The URL is revoked right after the click.
 */
function downloadCodes(codes: readonly string[]): void {
  const url = URL.createObjectURL(new Blob([recoveryCodesText(codes)], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = RECOVERY_CODES_FILE;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Props of {@link RecoveryCodesPanel}. */
export interface RecoveryCodesPanelProps {
  codes: readonly string[];
  /** "Ya los guardé": the codes leave memory. */
  onDone: () => void;
}

/**
 * Shows the recovery codes **once** (they are never fetched again), with
 * copy and download, and asks the user to confirm they saved them.
 */
export function RecoveryCodesPanel({ codes, onDone }: RecoveryCodesPanelProps): ReactNode {
  const [feedback, setFeedback] = useState<string | null>(null);

  const copy = (): void => {
    if (navigator.clipboard === undefined) {
      setFeedback("Tu navegador no deja copiar. Descárgalos o escríbelos en papel.");
      return;
    }
    navigator.clipboard
      .writeText(codes.join("\n"))
      .then(() => setFeedback("Copiados. Pégalos en un lugar seguro."))
      .catch(() => setFeedback("No pudimos copiarlos. Descárgalos o escríbelos en papel."));
  };

  return (
    <div className={styles.section}>
      <p className={styles.warning}>
        <strong>Guarda estos códigos ahora.</strong> Solo los verás esta vez. Cada uno sirve una vez para entrar si pierdes tu teléfono.
      </p>
      <ul className={styles.codes} aria-label="Códigos de recuperación">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className={styles.section}>
        <Button variant="secondary" fullWidth onClick={copy}>
          Copiar códigos
        </Button>
        <Button variant="secondary" fullWidth onClick={() => downloadCodes(codes)}>
          Descargar como texto
        </Button>
        <output className={styles.muted} aria-live="polite">
          {feedback}
        </output>
        <Button fullWidth size="lg" onClick={onDone}>
          Ya los guardé
        </Button>
      </div>
    </div>
  );
}
