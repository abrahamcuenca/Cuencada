/**
 * Fictional e2e fixtures (the repo is public: no real people, no real
 * contact data). Shared by the harness seed and the specs.
 *
 * Every Playwright project gets its own cast, keyed by {@link ProjectKey},
 * so projects can run in parallel against one API without stepping on each
 * other (password changes, logout-all, the directory switch, the tree).
 */

/** Playwright project names (see `playwright.config.ts`). */
export const ProjectKey = {
  Iphone: "iphone-13",
  Pixel: "pixel-7",
  Desktop: "desktop-1280"
} as const;
export type ProjectKey = (typeof ProjectKey)[keyof typeof ProjectKey];

export const PROJECT_KEYS: readonly ProjectKey[] = Object.values(ProjectKey);

/** Fictional surname per project, so names stay unique across projects. */
const SURNAMES: Record<ProjectKey, string> = {
  [ProjectKey.Iphone]: "Ejemplo",
  [ProjectKey.Pixel]: "Muestra",
  [ProjectKey.Desktop]: "Ficticio"
};

/** Password of every seeded account that does not need to change it. */
export const MEMBER_PASSWORD = "Prueba-e2e-segura-2027";
/** Temporary password of the per-project "first login" admins. */
export const TEMP_ADMIN_PASSWORD = "Temporal-e2e-admin-2027";
/** The new password the first-login journey sets. */
export const NEW_ADMIN_PASSWORD = "Nueva-e2e-admin-segura-2027";

/** Roles in a project's cast. */
export const CastRole = {
  /** Admin with `must_change_password` (journey 1). */
  FirstLoginAdmin: "firstadmin",
  /** Admin ready to use (invites, family tree). */
  Admin: "admin",
  /** Member: RSVP, directory searcher, chat sender. */
  Ana: "ana",
  /** Member: directory target, chat receiver. */
  Beto: "beto",
  /** Member: flips "Aparecer en el directorio" off. */
  Carla: "carla",
  /** Member: magic-link login. */
  Dario: "dario",
  /** Member: logout everywhere. */
  Elena: "elena",
  /** Member: gallery upload. */
  Fede: "fede"
} as const;
export type CastRole = (typeof CastRole)[keyof typeof CastRole];

/** A seeded account. */
export interface CastMember {
  email: string;
  password: string;
  displayName: string;
  firstName: string;
  role: "admin" | "member";
  mustChangePassword: boolean;
  city: string;
}

const FIRST_NAMES: Record<CastRole, string> = {
  firstadmin: "Irene",
  admin: "Octavio",
  ana: "Ana",
  beto: "Beto",
  carla: "Carla",
  dario: "Darío",
  elena: "Elena",
  fede: "Fede"
};

/**
 * The seeded account for `role` in `project`.
 *
 * @param project - Playwright project name.
 * @param role - Cast role.
 */
export function castMember(project: ProjectKey, role: CastRole): CastMember {
  const firstName = FIRST_NAMES[role];
  const admin = role === CastRole.FirstLoginAdmin || role === CastRole.Admin;
  return {
    email: `${role}.${project}@e2e.example.test`,
    password: role === CastRole.FirstLoginAdmin ? TEMP_ADMIN_PASSWORD : MEMBER_PASSWORD,
    displayName: `${firstName} ${SURNAMES[project]}`,
    firstName,
    role: admin ? "admin" : "member",
    mustChangePassword: role === CastRole.FirstLoginAdmin,
    city: "Pueblo Ejemplo"
  };
}

/** Email of the member a project's admin invites in journey 2 (not seeded). */
export function inviteeEmail(project: ProjectKey): string {
  return `invitada.${project}@e2e.example.test`;
}

/** Name the invitee types when accepting. */
export function inviteeName(project: ProjectKey): string {
  return `Gina ${SURNAMES[project]}`;
}

/** Family-tree people per project (no accounts unless linked). */
export function familyNames(project: ProjectKey): { parent: string; partner: string; grandparent: string; greatGrandparent: string } {
  return {
    parent: `Ramón ${SURNAMES[project]}`,
    partner: `Sofía ${SURNAMES[project]}`,
    // WP-4.3: a deceased line above the parent (the tree-photo journey frames a photo for the great-grandparent).
    grandparent: `Lucía ${SURNAMES[project]}`,
    greatGrandparent: `Tomás ${SURNAMES[project]}`
  };
}

/** The fictional future edition the RSVP journeys use. */
export const FUTURE_YEAR = 2027;
/** The seeded (past) edition whose public programa the offline journey caches. */
export const SEEDED_YEAR = 2026;
/** A fictional announced edition (WP-3.1a): published, no dates and no place yet. */
export const ANNOUNCED_YEAR = 2028;
