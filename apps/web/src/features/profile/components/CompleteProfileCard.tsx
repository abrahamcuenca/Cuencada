import { type ReactNode, useId, useState } from "react";
import { useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { IconButton } from "../../../shared/ui/IconButton";
import { selectAuthStatus, selectCurrentUser, selectPasswordChangeRequired } from "../../auth/authSlice";
import { useGetProfileQuery } from "../api";
import { dismissProfilePrompt, isProfilePromptDismissed, needsProfileCompletion } from "../lib/completeness";
import { PROFILE_PATH } from "../paths";
import styles from "./CompleteProfileCard.module.css";

/** Title of the Home card (WP-4.7). */
export const COMPLETE_PROFILE_TITLE = "Completa tu perfil: foto y contacto";

/**
 * Home card for logged-in members whose profile has no photo and no contact
 * (WP-4.7): "Completa tu perfil: foto y contacto" with a link to `/perfil`.
 * Closing it is remembered per user on this device (localStorage, best
 * effort). The `/me` avatar short-circuits the check: a member with a photo
 * never triggers the profile request.
 */
export function CompleteProfileCard(): ReactNode {
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  const mustChange = useAppSelector(selectPasswordChangeRequired);
  const userId = status === "authenticated" && !mustChange ? (user?.id ?? null) : null;
  // Keyed by user, so an account switch re-reads that user's own dismissal.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const dismissed = userId !== null && (dismissedFor === userId || isProfilePromptDismissed(userId));
  const eligible = userId !== null && user?.avatarUrl === null && !dismissed;
  const { data } = useGetProfileQuery(undefined, { skip: !eligible });
  const titleId = useId();

  if (!eligible || data === undefined || data.userId !== userId || !needsProfileCompletion(data)) return null;

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <span aria-hidden="true" className={styles.icon}>
        📇
      </span>
      <div className={styles.body}>
        <h2 id={titleId} className={styles.title}>
          {COMPLETE_PROFILE_TITLE}
        </h2>
        <p className={styles.text}>Así la familia te reconoce en las fotos y sabe cómo escribirte. Tú decides qué se muestra.</p>
        <Button to={PROFILE_PATH} size="sm" className={styles.action}>
          Completar perfil
        </Button>
      </div>
      <IconButton
        label="Ocultar la sugerencia de completar tu perfil"
        icon="✕"
        variant="plain"
        className={styles.close}
        onClick={() => {
          dismissProfilePrompt(userId);
          setDismissedFor(userId);
        }}
      />
    </section>
  );
}
