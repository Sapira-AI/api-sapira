DROP TRIGGER IF EXISTS "trigger_auto_populate_invoice_item_fields" ON "public"."invoice_items";

CREATE TRIGGER "trigger_auto_populate_invoice_item_fields"
BEFORE INSERT
ON "public"."invoice_items"
FOR EACH ROW
EXECUTE FUNCTION auto_populate_invoice_item_fields();
