DROP TRIGGER IF EXISTS "trigger_prevent_confirmed_match_edit" ON "public"."invoice_items_legacy_match";

CREATE TRIGGER "trigger_prevent_confirmed_match_edit"
BEFORE UPDATE
ON "public"."invoice_items_legacy_match"
FOR EACH ROW
EXECUTE FUNCTION prevent_confirmed_match_edit();
