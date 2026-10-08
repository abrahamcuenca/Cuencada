/**
 * Links into "Mi perfil" (WP-4.7), shared by the account menu, `/mas`, the
 * directory, the family tree and Home. Tiny on purpose: importing it never
 * pulls the profile page or its API into another chunk.
 */

/** "Mi perfil". */
export const PROFILE_PATH = "/perfil";
/** `id` of the "Contacto" section on `/perfil`. */
export const CONTACT_SECTION_ID = "contacto";
/** "Mi perfil" scrolled to its "Contacto" section. */
export const PROFILE_CONTACT_PATH = `${PROFILE_PATH}#${CONTACT_SECTION_ID}`;
