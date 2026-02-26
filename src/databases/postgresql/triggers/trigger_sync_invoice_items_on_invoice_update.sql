DROP TRIGGER IF EXISTS "trigger_sync_invoice_items_on_invoice_update" ON "public"."invoices";

CREATE TRIGGER "trigger_sync_invoice_items_on_invoice_update"
AFTER UPDATE
ON "public"."invoices"
FOR EACH ROW
EXECUTE FUNCTION sync_invoice_items_on_invoice_update();
