import { type AvatarSize, AvatarCircle } from "./AvatarCircle";
import styles from "./AvatarStack.module.css";
import { cx } from "./cx";

/** A person shown in an {@link AvatarStack}. */
export interface AvatarStackPerson {
  id: string;
  name: string;
  src?: string | undefined;
}

/** Props for {@link AvatarStack}. */
export interface AvatarStackProps {
  people: readonly AvatarStackPerson[];
  /** Max avatars before collapsing into "+N". Defaults to 5 (fits 320px at size md). */
  max?: number;
  size?: AvatarSize;
  /** Total when the list is paginated (e.g. 48 attendees but only 5 loaded). */
  total?: number;
  /** Accessible group label; defaults to "{total} asistentes". */
  label?: string;
  /** `overlap` = compact stack, `grid` = wrapping row of circles (attendee section). */
  layout?: "overlap" | "grid";
  className?: string | undefined;
}

/** Overlapping (or wrapping) attendee circles with a "+N" overflow chip. */
export function AvatarStack({ people, max = 5, size = "md", total, label, layout = "overlap", className }: AvatarStackProps): React.ReactNode {
  const count = total ?? people.length;
  const visible = people.slice(0, max);
  const overflow = count - visible.length;
  const groupLabel = label ?? `${count} ${count === 1 ? "asistente" : "asistentes"}`;

  return (
    <ul aria-label={groupLabel} className={cx(styles.stack, styles[layout], styles[size], className)}>
      {visible.map((person) => (
        <li key={person.id} className={styles.item}>
          <AvatarCircle name={person.name} src={person.src} size={size} />
        </li>
      ))}
      {overflow > 0 ? (
        <li className={styles.item}>
          <span className={cx(styles.more, styles[`more-${size}`])} role="img" aria-label={`y ${overflow} más`}>
            +{overflow}
          </span>
        </li>
      ) : null}
    </ul>
  );
}
