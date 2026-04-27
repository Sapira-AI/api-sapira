DROP TRIGGER IF EXISTS "trigger_create_standard_agents" ON "public"."company_holdings";

CREATE TRIGGER "trigger_create_standard_agents"
AFTER INSERT
ON "public"."company_holdings"
FOR EACH ROW
EXECUTE FUNCTION create_standard_agents_for_holding();
