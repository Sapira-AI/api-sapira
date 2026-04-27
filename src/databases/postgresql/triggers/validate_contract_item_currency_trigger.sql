DROP TRIGGER IF EXISTS "validate_contract_item_currency_trigger" ON "public"."contract_items";

CREATE TRIGGER "validate_contract_item_currency_trigger"
BEFORE INSERT OR UPDATE
ON "public"."contract_items"
FOR EACH ROW
EXECUTE FUNCTION validate_contract_item_currency_consistency();
