DROP TRIGGER IF EXISTS "trg_sync_invoice_items_from_quantities" ON "public"."quantities";

CREATE TRIGGER "trg_sync_invoice_items_from_quantities"
AFTER INSERT OR UPDATE
ON "public"."quantities"
FOR EACH ROW
EXECUTE FUNCTION sync_invoice_items_amounts_from_quantities();
