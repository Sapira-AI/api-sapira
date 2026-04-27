DROP TRIGGER IF EXISTS "trg_quote_items_calculate_pricing" ON "public"."quote_items";

CREATE TRIGGER "trg_quote_items_calculate_pricing"
BEFORE INSERT OR UPDATE
ON "public"."quote_items"
FOR EACH ROW
EXECUTE FUNCTION auto_calculate_pricing_fields();
