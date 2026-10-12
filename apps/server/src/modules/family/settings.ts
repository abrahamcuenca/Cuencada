/**
 * Family settings (WP-6.4): the root ancestor ("Raíz del árbol") of
 * "Árbol completo" and of the "Ramas sin conectar" report. One row
 * (`family_settings.id = true`), inserted by migration 0010; the test
 * harness truncates it, so writes **upsert** and a missing row reads as
 * "no root" (WP-6.0 decision 6).
 */
import { AuditAction, AuditEntityType, type FamilySettings } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { familySettings, people } from "../../db/schema/index.js";
import { type DbOrTx, recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import type { AvatarUrlDeps } from "../profile/avatar.js";
import { AvatarSize } from "../profile/constants.js";
import { findPerson, presignPersonAvatars, toPersonSummary, type Viewer } from "./repository.js";
import type { WriteActor } from "./writes.js";

const ROOT_NOT_FOUND = "No encontramos a esa persona.";

/** The stored settings row, or the defaults when it is missing. */
export async function readFamilySettingsRow(db: DbOrTx): Promise<{ rootPersonId: string | null; updatedAt: Date | null }> {
  const [row] = await db
    .select({ rootPersonId: familySettings.rootPersonId, updatedAt: familySettings.updatedAt })
    .from(familySettings)
    .where(eq(familySettings.id, true))
    .limit(1);
  return row ?? { rootPersonId: null, updatedAt: null };
}

/** The root person id, or `null`. */
export async function readRootPersonId(db: DbOrTx): Promise<string | null> {
  return (await readFamilySettingsRow(db)).rootPersonId;
}

/**
 * The settings as `viewer` sees them (the root as a `PersonSummary` under
 * the usual photo and link rules).
 *
 * @param deps - Client, storage and logger.
 * @param viewer - The caller.
 */
export async function loadFamilySettings(deps: AvatarUrlDeps & { db: DbOrTx }, viewer: Viewer): Promise<FamilySettings> {
  const row = await readFamilySettingsRow(deps.db);
  const root = row.rootPersonId === null ? undefined : await findPerson(deps.db, row.rootPersonId);
  if (root === undefined) return { root: null, updatedAt: row.updatedAt?.toISOString() ?? null };
  const avatars = await presignPersonAvatars(deps, [root], viewer, AvatarSize.Small);
  return { root: toPersonSummary(root, viewer, avatars), updatedAt: row.updatedAt?.toISOString() ?? null };
}

/**
 * Set (or clear) the root, upserting the single row, audited with the id only.
 *
 * @param tx - Open transaction.
 * @param rootPersonId - The new root, or `null`.
 * @param actor - The admin.
 * @throws AppError 400 `VALIDATION` (`rootPersonId`) for an unknown person.
 */
export async function updateFamilySettingsTx(tx: Transaction, rootPersonId: string | null, actor: WriteActor): Promise<void> {
  if (rootPersonId !== null) {
    // Locked so a concurrent delete cannot slip between the check and the write.
    const [person] = await tx.select({ id: people.id }).from(people).where(eq(people.id, rootPersonId)).limit(1).for("share");
    if (person === undefined) {
      throw new AppError("VALIDATION", ROOT_NOT_FOUND, { details: [{ path: "rootPersonId", message: ROOT_NOT_FOUND }] });
    }
  }
  await tx
    .insert(familySettings)
    .values({ id: true, rootPersonId, updatedByUserId: actor.id })
    .onConflictDoUpdate({ target: familySettings.id, set: { rootPersonId, updatedByUserId: actor.id, updatedAt: new Date() } });
  await recordAudit(tx, {
    actorUserId: actor.id,
    action: AuditAction.FamilySettingsUpdated,
    entityType: AuditEntityType.FamilySettings,
    entityId: null,
    metadata: { rootPersonId },
    ip: actor.ip
  });
}

/**
 * Inside a merge: the root moves from the duplicate to the person that stays
 * (before the duplicate is deleted, which would null it).
 */
export async function moveRootTx(tx: Transaction, fromPersonId: string, toPersonId: string): Promise<boolean> {
  const moved = await tx
    .update(familySettings)
    .set({ rootPersonId: toPersonId })
    .where(eq(familySettings.rootPersonId, fromPersonId))
    .returning({ id: familySettings.id });
  return moved.length > 0;
}
