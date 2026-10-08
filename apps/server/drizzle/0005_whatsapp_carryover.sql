-- Migration 0005 (WP-4.4b): carry the shared phone over to WhatsApp. DATA ONLY,
-- no schema change (meta/0005_snapshot.json equals 0004's schema).
--
-- Before WP-4.4 the directory built a WhatsApp button from a shown phone. Since
-- WP-4.4 WhatsApp is its own field (empty and hidden by default), so existing
-- members would lose that button. Owner decision: carry over what they had
-- already shared.
--
-- Only profiles whose phone is already E.164 (the same pattern as
-- `profiles_whatsapp_check`, `E164_PATTERN` in @cuencada/types) and that have
-- no WhatsApp yet:
--   * whatsapp = phone;
--   * contact_visibility gains "whatsapp": show_phone, unless the key is
--     already there (an explicit choice is never overwritten).
-- Legacy free-form phones are untouched (their owners keep the "Confirma tu
-- teléfono" prompt), and show_phone is never changed.
--
-- Idempotent: after one run every matching row has a WhatsApp, so a re-run
-- matches nothing. The statement returns no rows, so no PII reaches any output.
UPDATE "profiles"
SET
  "whatsapp" = "phone",
  "contact_visibility" = CASE
    WHEN "contact_visibility" ? 'whatsapp' THEN "contact_visibility"
    ELSE "contact_visibility" || jsonb_build_object('whatsapp', "show_phone")
  END
WHERE "whatsapp" IS NULL
  AND "phone" IS NOT NULL
  AND "phone" ~ '^[+][1-9][0-9]{6,14}$';
