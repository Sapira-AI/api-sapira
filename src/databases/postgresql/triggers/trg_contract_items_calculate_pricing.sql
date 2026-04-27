DROP TRIGGER IF EXISTS "trg_contract_items_calculate_pricing" ON "public"."contract_items";

CREATE TRIGGER "trg_contract_items_calculate_pricing"
BEFORE INSERT OR UPDATE
ON "public"."contract_items"
FOR EACH ROW
EXECUTE FUNCTION auto_calculate_pricing_fields();
