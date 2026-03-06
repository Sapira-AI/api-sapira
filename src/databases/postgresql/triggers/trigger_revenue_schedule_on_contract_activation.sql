DROP TRIGGER IF EXISTS "trigger_revenue_schedule_on_contract_activation" ON "public"."contracts";

CREATE TRIGGER "trigger_revenue_schedule_on_contract_activation"
AFTER UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION trigger_revenue_schedule_on_contract_activation();
