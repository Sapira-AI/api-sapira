DROP TRIGGER IF EXISTS "trg_invoice_item_change" ON "public"."invoice_items";

CREATE TRIGGER "trg_invoice_item_change"
AFTER DELETE OR INSERT OR UPDATE
ON "public"."invoice_items"
FOR EACH ROW
EXECUTE FUNCTION refresh_revenue_schedule_for_invoice_contract();
