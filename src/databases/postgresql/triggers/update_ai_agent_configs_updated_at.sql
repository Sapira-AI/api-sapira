DROP TRIGGER IF EXISTS "update_ai_agent_configs_updated_at" ON "public"."ai_agent_configs";

CREATE TRIGGER "update_ai_agent_configs_updated_at"
BEFORE UPDATE
ON "public"."ai_agent_configs"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
