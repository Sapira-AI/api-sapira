DROP TRIGGER IF EXISTS "trigger_update_client_agent_configs_updated_at" ON "public"."client_agent_configs";

CREATE TRIGGER "trigger_update_client_agent_configs_updated_at"
BEFORE UPDATE
ON "public"."client_agent_configs"
FOR EACH ROW
EXECUTE FUNCTION update_client_agent_configs_updated_at();
