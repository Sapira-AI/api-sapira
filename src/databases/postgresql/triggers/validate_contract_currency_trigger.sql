DROP TRIGGER IF EXISTS "validate_contract_currency_trigger" ON "public"."contracts";

CREATE TRIGGER "validate_contract_currency_trigger"
BEFORE INSERT OR UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION validate_contract_currency_consistency();
