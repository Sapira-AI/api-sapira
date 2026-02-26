DROP TRIGGER IF EXISTS "trigger_sync_invoice_item_contract_id" ON "public"."invoice_items";

CREATE TRIGGER "trigger_sync_invoice_item_contract_id"
BEFORE INSERT OR UPDATE
ON "public"."invoice_items"
FOR EACH ROW
EXECUTE FUNCTION sync_invoice_item_contract_id();
