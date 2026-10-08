-- Migration 0006 (WP-4.5): allow the `person.merge` revision action
-- ("Fusionar personas"). EXPAND-ONLY: the CHECK is replaced by a strictly
-- wider list (every value accepted before is still accepted), so code from
-- 0004/0005 keeps working. No data step.
--
-- Added NOT VALID and validated right after, like 0002/0003: the validation
-- only reads `person_revisions`, whose existing rows all satisfy the old,
-- narrower list. Both statements run in the migration transaction, so there
-- is no window without a CHECK.
ALTER TABLE "person_revisions" DROP CONSTRAINT "person_revisions_action_check";--> statement-breakpoint
ALTER TABLE "person_revisions" ADD CONSTRAINT "person_revisions_action_check" CHECK ("action" in ('person.create', 'person.update', 'person.delete', 'relationship.create', 'relationship.delete', 'person.photo', 'person.revert', 'person.merge')) NOT VALID;--> statement-breakpoint
ALTER TABLE "person_revisions" VALIDATE CONSTRAINT "person_revisions_action_check";
