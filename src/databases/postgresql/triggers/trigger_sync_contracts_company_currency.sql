DROP TRIGGER IF EXISTS "trigger_sync_contracts_company_currency" ON "public"."companies";

CREATE TRIGGER "trigger_sync_contracts_company_currency"
AFTER UPDATE
ON "public"."companies"
FOR EACH ROW
EXECUTE FUNCTION sync_contracts_company_currency();
