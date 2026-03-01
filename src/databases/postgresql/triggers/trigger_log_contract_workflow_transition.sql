DROP TRIGGER IF EXISTS "trigger_log_contract_workflow_transition" ON "public"."contracts";

CREATE TRIGGER "trigger_log_contract_workflow_transition"
BEFORE UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION log_contract_workflow_transition();
