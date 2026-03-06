DROP TRIGGER IF EXISTS "update_invoice_items_updated_at_trigger" ON "public"."invoice_items";

CREATE TRIGGER "update_invoice_items_updated_at_trigger"
BEFORE UPDATE
ON "public"."invoice_items"
FOR EACH ROW
EXECUTE FUNCTION update_invoice_items_updated_at();
