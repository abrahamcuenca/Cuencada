import { type ReactNode, useId, useRef, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { TextInput } from "../../../shared/ui/TextInput";
import styles from "../admin.module.css";
import { Notice } from "./common";

/** Props for {@link InviteLinkBox}. */
export interface InviteLinkBoxProps {
  /** The one-time `inviteUrl` (`…/invitacion#t=…`). Held in component state only. */
  url: string;
  /** Called when the admin is done; the parent drops the URL from memory. */
  onDone: () => void;
}

/** Message shared on WhatsApp with the link. */
export const WHATSAPP_INVITE_TEXT = "¡Te invitamos al portal de la Cuencada! Crea tu cuenta con este enlace:";

/**
 * @param url - The invite URL.
 * @returns A `wa.me` share link with the message and the URL, percent-encoded.
 */
export function whatsappShareHref(url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(`${WHATSAPP_INVITE_TEXT} ${url}`)}`;
}

/**
 * The open invite's link, shown exactly once (only its hash is stored on the
 * server). Copy, share on WhatsApp, or close. Never written to storage or logs.
 */
export function InviteLinkBox({ url, onDone }: InviteLinkBoxProps): ReactNode {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);

  const copy = async (): Promise<void> => {
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setStatus({ tone: "success", message: "Enlace copiado. Pégalo en el chat de la familia." });
    } catch {
      // Clipboard blocked (permissions, older browser): select the text so the admin can copy it by hand.
      input.current?.select();
      setStatus({ tone: "danger", message: "No pudimos copiarlo. Mantén presionado el enlace para copiarlo." });
    }
  };

  return (
    <section aria-labelledby={`${inputId}-title`} className={styles.linkBox}>
      <h2 id={`${inputId}-title`} className={styles.sectionTitle}>
        Enlace de invitación listo
      </h2>
      <p className={styles.warning}>
        <span aria-hidden="true">⚠️ </span>
        Este enlace solo se muestra una vez. Cópialo o compártelo ahora; después no podrás volver a verlo.
      </p>
      <label htmlFor={inputId} className="visually-hidden">
        Enlace de invitación
      </label>
      <TextInput
        id={inputId}
        ref={input}
        readOnly
        value={url}
        className={styles.urlInput}
        onFocus={(event) => event.currentTarget.select()}
      />
      <Notice message={status?.tone === "success" ? status.message : null} tone="success" />
      <Notice message={status?.tone === "danger" ? status.message : null} />
      <div className={styles.actions}>
        <Button icon="📋" onClick={() => void copy()}>
          Copiar enlace
        </Button>
        <Button variant="whatsapp" href={whatsappShareHref(url)} external>
          Compartir por WhatsApp
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Listo
        </Button>
      </div>
    </section>
  );
}
