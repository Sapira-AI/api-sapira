DROP TRIGGER IF EXISTS "trigger_auto_populate_invoice_fx_to_system" ON "public"."invoices";

CREATE TRIGGER "trigger_auto_populate_invoice_fx_to_system"
BEFORE INSERT OR UPDATE
ON "public"."invoices"
FOR EACH ROW
EXECUTE FUNCTION auto_populate_invoice_fx_to_system();
