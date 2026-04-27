DROP TRIGGER IF EXISTS "trigger_auto_populate_client_tax_id" ON "public"."invoices_legacy";

CREATE TRIGGER "trigger_auto_populate_client_tax_id"
BEFORE INSERT OR UPDATE
ON "public"."invoices_legacy"
FOR EACH ROW
EXECUTE FUNCTION auto_populate_client_tax_id_from_entity();
