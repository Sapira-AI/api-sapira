DROP TRIGGER IF EXISTS "trigger_set_contract_company_currency" ON "public"."contracts";

CREATE TRIGGER "trigger_set_contract_company_currency"
BEFORE INSERT OR UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION set_contract_company_currency();
