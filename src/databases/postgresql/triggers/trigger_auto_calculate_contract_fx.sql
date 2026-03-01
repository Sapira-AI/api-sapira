DROP TRIGGER IF EXISTS "trigger_auto_calculate_contract_fx" ON "public"."contracts";

CREATE TRIGGER "trigger_auto_calculate_contract_fx"
AFTER INSERT OR UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION auto_calculate_contract_fx();
