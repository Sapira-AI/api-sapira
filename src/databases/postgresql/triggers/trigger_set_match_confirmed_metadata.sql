DROP TRIGGER IF EXISTS "trigger_set_match_confirmed_metadata" ON "public"."invoice_items_legacy_match";

CREATE TRIGGER "trigger_set_match_confirmed_metadata"
BEFORE UPDATE
ON "public"."invoice_items_legacy_match"
FOR EACH ROW
EXECUTE FUNCTION set_match_confirmed_metadata();
