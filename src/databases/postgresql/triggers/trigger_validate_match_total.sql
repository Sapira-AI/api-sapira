DROP TRIGGER IF EXISTS "trigger_validate_match_total" ON "public"."invoice_items_legacy_match";

CREATE TRIGGER "trigger_validate_match_total"
BEFORE INSERT OR UPDATE
ON "public"."invoice_items_legacy_match"
FOR EACH ROW
EXECUTE FUNCTION validate_match_total();
