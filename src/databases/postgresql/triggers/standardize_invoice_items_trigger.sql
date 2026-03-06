DROP TRIGGER IF EXISTS "standardize_invoice_items_trigger" ON "public"."invoice_items";

CREATE TRIGGER "standardize_invoice_items_trigger"
BEFORE INSERT
ON "public"."invoice_items"
FOR EACH ROW
EXECUTE FUNCTION standardize_invoice_items();
