DROP TRIGGER IF EXISTS "trigger_update_invoice_legacy_status" ON "public"."invoice_items_legacy_match";

CREATE TRIGGER "trigger_update_invoice_legacy_status"
AFTER DELETE OR INSERT OR UPDATE
ON "public"."invoice_items_legacy_match"
FOR EACH ROW
EXECUTE FUNCTION update_invoice_legacy_status();
