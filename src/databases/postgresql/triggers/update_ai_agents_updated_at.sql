DROP TRIGGER IF EXISTS "update_ai_agents_updated_at" ON "public"."ai_agents";

CREATE TRIGGER "update_ai_agents_updated_at"
BEFORE UPDATE
ON "public"."ai_agents"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
